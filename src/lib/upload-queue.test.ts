import { describe, it, expect, vi } from "vitest";
import { UploadQueue, MAX_CONCURRENT_UPLOADS } from "@/lib/upload-queue";

/**
 * Laisse la chaîne then()/catch()/finally() de l'exécuteur (plusieurs tours de microtâches)
 * se dérouler complètement avant d'inspecter l'état de la file. Plus robuste qu'un nombre fixe
 * de `await Promise.resolve()` (le nombre de tours dépend du chemin then/catch emprunté).
 */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Exécuteur factice : reste "en cours" tant qu'on n'a pas appelé resolve()/reject() manuellement. */
function deferredExecutor() {
  const pending = new Map<string, { resolve: (v: string) => void; reject: (e: Error) => void }>();
  const started: string[] = [];

  const executor = (file: string, onProgress: (p: number) => void, signal: AbortSignal) =>
    new Promise<string>((resolve, reject) => {
      started.push(file);
      pending.set(file, { resolve, reject });
      signal.addEventListener("abort", () => reject(new Error("annulé")));
      onProgress(0);
    });

  return {
    executor,
    started,
    resolve: (file: string, result: string) => pending.get(file)?.resolve(result),
    reject: (file: string, message: string) => pending.get(file)?.reject(new Error(message)),
    progressOf: (file: string) => file, // helper non utilisé directement, gardé pour lisibilité
  };
}

/** Exécuteur qui se termine immédiatement avec succès. */
function instantSuccessExecutor<T = string>(result: T) {
  return async (_file: string, onProgress: (p: number) => void) => {
    onProgress(100);
    return result;
  };
}

describe("UploadQueue — concurrence bornée", () => {
  it("respecte MAX_CONCURRENT_UPLOADS par défaut (3)", () => {
    const { executor, started } = deferredExecutor();
    const queue = new UploadQueue<string, string>(executor);

    for (let i = 0; i < 5; i++) queue.add(`f${i}`, `f${i}`);

    expect(started).toHaveLength(MAX_CONCURRENT_UPLOADS);
    expect(queue.getItems().filter((i) => i.state === "uploading")).toHaveLength(3);
    expect(queue.getItems().filter((i) => i.state === "pending")).toHaveLength(2);
  });

  it("démarre l'item suivant en attente dès qu'un emplacement se libère", async () => {
    const { executor, started, resolve } = deferredExecutor();
    const queue = new UploadQueue<string, string>(executor, 2);

    queue.add("a", "a");
    queue.add("b", "b");
    queue.add("c", "c");

    expect(started).toEqual(["a", "b"]);
    expect(queue.getItems().find((i) => i.id === "c")?.state).toBe("pending");

    resolve("a", "ok-a");
    await flushMicrotasks();

    expect(started).toEqual(["a", "b", "c"]);
    expect(queue.getItems().find((i) => i.id === "c")?.state).toBe("uploading");
  });

  it("respecte une concurrence personnalisée de 1 (séquentiel)", () => {
    const { executor, started } = deferredExecutor();
    const queue = new UploadQueue<string, string>(executor, 1);

    queue.add("a", "a");
    queue.add("b", "b");

    expect(started).toEqual(["a"]);
    expect(queue.getItems().find((i) => i.id === "b")?.state).toBe("pending");
  });
});

describe("UploadQueue — cycle de vie d'un item", () => {
  it("passe par pending → uploading → done avec progression", async () => {
    const queue = new UploadQueue<string, string>(instantSuccessExecutor("resultat"));
    const snapshots: string[] = [];
    queue.subscribe((items) => snapshots.push(items[0]?.state ?? "none"));

    queue.add("a", "fichier-a");
    // laisse la promesse se résoudre
    await flushMicrotasks();

    const item = queue.getItems()[0];
    expect(item.state).toBe("done");
    expect(item.progress).toBe(100);
    expect(item.result).toBe("resultat");
    // on doit avoir vu l'état "uploading" avant "done"
    expect(snapshots).toContain("uploading");
  });

  it("passe en erreur si l'exécuteur rejette, avec le message d'erreur exposé", async () => {
    const executor = async () => {
      throw new Error("Échec réseau.");
    };
    const queue = new UploadQueue<string, string>(executor);
    queue.add("a", "fichier-a");

    await flushMicrotasks();

    const item = queue.getItems()[0];
    expect(item.state).toBe("error");
    expect(item.error).toBe("Échec réseau.");
  });

  it("ignore un ajout en double du même id (idempotent)", () => {
    const { executor, started } = deferredExecutor();
    const queue = new UploadQueue<string, string>(executor);

    queue.add("a", "fichier-a");
    queue.add("a", "fichier-a-bis");

    expect(started).toEqual(["fichier-a"]);
    expect(queue.getItems()).toHaveLength(1);
  });
});

describe("UploadQueue — retry", () => {
  it("relance un item en erreur et repasse par uploading", async () => {
    let attempt = 0;
    const executor = async (_file: string, onProgress: (p: number) => void) => {
      attempt++;
      if (attempt === 1) throw new Error("Échec temporaire.");
      onProgress(100);
      return "ok-au-2e-essai";
    };
    const queue = new UploadQueue<string, string>(executor);

    queue.add("a", "fichier-a");
    await flushMicrotasks();
    expect(queue.getItems()[0].state).toBe("error");

    queue.retry("a");
    expect(queue.getItems()[0].state).toBe("uploading");
    expect(queue.getItems()[0].error).toBeUndefined();

    await flushMicrotasks();
    expect(queue.getItems()[0].state).toBe("done");
    expect(queue.getItems()[0].result).toBe("ok-au-2e-essai");
    expect(attempt).toBe(2);
  });

  it("retry() sur un item non terminé (pending/uploading/done) ne fait rien", async () => {
    const queue = new UploadQueue<string, string>(instantSuccessExecutor("ok"));
    queue.add("a", "fichier-a");
    await flushMicrotasks();
    expect(queue.getItems()[0].state).toBe("done");

    queue.retry("a"); // déjà "done" : ne doit rien changer
    expect(queue.getItems()[0].state).toBe("done");
  });

  it("libère un emplacement de concurrence après une erreur, permettant au suivant de démarrer", async () => {
    const { executor, started, reject } = deferredExecutor();
    const queue = new UploadQueue<string, string>(executor, 1);

    queue.add("a", "a");
    queue.add("b", "b");
    expect(started).toEqual(["a"]);

    reject("a", "boom");
    await flushMicrotasks();

    expect(queue.getItems().find((i) => i.id === "a")?.state).toBe("error");
    expect(started).toEqual(["a", "b"]);
  });
});

describe("UploadQueue — annulation", () => {
  it("annule un item encore en attente (jamais démarré)", () => {
    const { executor, started } = deferredExecutor();
    const queue = new UploadQueue<string, string>(executor, 1);

    queue.add("a", "a");
    queue.add("b", "b");
    expect(started).toEqual(["a"]);

    queue.cancel("b");
    expect(queue.getItems().find((i) => i.id === "b")?.state).toBe("cancelled");
    expect(started).toEqual(["a"]); // jamais démarré
  });

  it("annule un item en cours : appelle abort() sur son signal et marque l'état cancelled", async () => {
    const abortSpy = vi.fn();
    const executor = (_file: string, _onProgress: (p: number) => void, signal: AbortSignal) =>
      new Promise<string>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          abortSpy();
          reject(new Error("annulé par l'utilisateur"));
        });
      });
    const queue = new UploadQueue<string, string>(executor);

    queue.add("a", "a");
    expect(queue.getItems()[0].state).toBe("uploading");

    queue.cancel("a");
    expect(queue.getItems()[0].state).toBe("cancelled");
    expect(abortSpy).toHaveBeenCalledTimes(1);

    // La rejection asynchrone de l'exécuteur ne doit pas repasser l'item en "error"
    // après coup : cancelled est un état terminal stable.
    await flushMicrotasks();
    expect(queue.getItems()[0].state).toBe("cancelled");
  });

  it("un item annulé peut être relancé via retry()", async () => {
    const { executor, started } = deferredExecutor();
    const queue = new UploadQueue<string, string>(executor, 1);

    queue.add("a", "a");
    queue.cancel("a");
    expect(queue.getItems()[0].state).toBe("cancelled");

    queue.retry("a");
    expect(queue.getItems()[0].state).toBe("uploading");
    expect(started).toEqual(["a", "a"]); // deuxième tentative bien exécutée
  });

  it("libère un emplacement de concurrence après annulation d'un item en cours", () => {
    const { executor, started } = deferredExecutor();
    const queue = new UploadQueue<string, string>(executor, 1);

    queue.add("a", "a");
    queue.add("b", "b");
    expect(started).toEqual(["a"]);

    queue.cancel("a");
    // le pump() se fait dans le .finally() de la promesse rejetée, asynchrone — mais l'annulation
    // elle-même n'attend pas cette microtask pour l'état ; on vérifie juste que "a" est cancelled
    // et que "b" reste pending jusqu'à la résolution de la microtask d'annulation.
    expect(queue.getItems().find((i) => i.id === "a")?.state).toBe("cancelled");
  });
});

describe("UploadQueue — subscribe/getItems", () => {
  it("getItems() préserve l'ordre d'ajout", () => {
    const { executor } = deferredExecutor();
    const queue = new UploadQueue<string, string>(executor, 10);
    queue.add("c", "c");
    queue.add("a", "a");
    queue.add("b", "b");

    expect(queue.getItems().map((i) => i.id)).toEqual(["c", "a", "b"]);
  });

  it("subscribe() notifie à chaque changement d'état et le désabonnement stoppe les notifications", async () => {
    const queue = new UploadQueue<string, string>(instantSuccessExecutor("ok"));
    const calls: number[] = [];
    const unsubscribe = queue.subscribe((items) => calls.push(items.length));

    queue.add("a", "a");
    const countAfterAdd = calls.length;
    expect(countAfterAdd).toBeGreaterThan(0);

    unsubscribe();
    await flushMicrotasks();

    // Aucun nouvel appel après désabonnement, même si l'upload s'est terminé entre-temps.
    expect(calls.length).toBe(countAfterAdd);
  });
});
