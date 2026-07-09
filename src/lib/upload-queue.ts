// Petite file générique à concurrence bornée, dédiée à l'upload de plusieurs fichiers en parallèle
// sans saturer le réseau/la RAM du navigateur. Logique PURE : aucun accès réseau ici, l'exécuteur
// (la fonction qui fait vraiment l'upload) est injecté par l'appelant — voir MAX_CONCURRENT_UPLOADS
// et UploadQueue plus bas. Testée unitairement dans upload-queue.test.ts avec un exécuteur factice.

/** Nombre maximum d'uploads simultanés (le reste attend en file). */
export const MAX_CONCURRENT_UPLOADS = 3;

export type UploadItemState = "pending" | "uploading" | "done" | "error" | "cancelled";

export type UploadItem<TFile, TResult> = {
  id: string;
  file: TFile;
  state: UploadItemState;
  progress: number; // 0-100
  result?: TResult;
  error?: string;
};

/**
 * Exécuteur injecté : réalise l'upload réel d'un fichier. Reçoit un callback de progression et un
 * AbortSignal (pour l'annulation). Doit rejeter en cas d'erreur ou d'annulation.
 */
export type UploadExecutor<TFile, TResult> = (
  file: TFile,
  onProgress: (percent: number) => void,
  signal: AbortSignal
) => Promise<TResult>;

type Listener<TFile, TResult> = (items: UploadItem<TFile, TResult>[]) => void;

/**
 * File d'upload à concurrence bornée. Ajouter des fichiers avec `add()` ; ils démarrent
 * automatiquement dès qu'un emplacement se libère (max `concurrency` en cours simultanément).
 * `retry()` relance un item en erreur/annulé, `cancel()` annule un item en attente ou en cours
 * (abort du signal passé à l'exécuteur). `subscribe()` reçoit un instantané des items à chaque
 * changement d'état — pensé pour piloter un `useState` React sans dépendre de React ici.
 */
export class UploadQueue<TFile, TResult> {
  private items = new Map<string, UploadItem<TFile, TResult>>();
  private order: string[] = [];
  private controllers = new Map<string, AbortController>();
  private listeners = new Set<Listener<TFile, TResult>>();
  private readonly concurrency: number;
  private readonly executor: UploadExecutor<TFile, TResult>;

  constructor(executor: UploadExecutor<TFile, TResult>, concurrency: number = MAX_CONCURRENT_UPLOADS) {
    this.executor = executor;
    this.concurrency = Math.max(1, concurrency);
  }

  subscribe(listener: Listener<TFile, TResult>): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getItems(): UploadItem<TFile, TResult>[] {
    return this.order.map((id) => this.items.get(id)!);
  }

  add(id: string, file: TFile): void {
    if (this.items.has(id)) return;
    this.items.set(id, { id, file, state: "pending", progress: 0 });
    this.order.push(id);
    this.emit();
    this.pump();
  }

  retry(id: string): void {
    const item = this.items.get(id);
    if (!item || (item.state !== "error" && item.state !== "cancelled")) return;
    this.setItem(id, { ...item, state: "pending", progress: 0, error: undefined });
    this.pump();
  }

  cancel(id: string): void {
    const item = this.items.get(id);
    if (!item) return;
    if (item.state === "uploading") {
      this.controllers.get(id)?.abort();
      // La promesse rejetée par l'exécuteur retombera dans le catch de runItem() et marquera
      // l'item "error" ; on force ici l'état "cancelled" tout de suite pour un retour UI immédiat.
      this.setItem(id, { ...item, state: "cancelled" });
    } else if (item.state === "pending") {
      this.setItem(id, { ...item, state: "cancelled" });
    }
  }

  private runningCount(): number {
    let count = 0;
    for (const item of this.items.values()) {
      if (item.state === "uploading") count++;
    }
    return count;
  }

  private pump(): void {
    let free = this.concurrency - this.runningCount();
    if (free <= 0) return;

    for (const id of this.order) {
      if (free <= 0) break;
      const item = this.items.get(id);
      if (!item || item.state !== "pending") continue;
      free--;
      this.start(id);
    }
  }

  private start(id: string): void {
    const item = this.items.get(id);
    if (!item) return;

    const controller = new AbortController();
    this.controllers.set(id, controller);
    this.setItem(id, { ...item, state: "uploading", progress: 0, error: undefined });

    this.executor(
      item.file,
      (percent) => {
        const current = this.items.get(id);
        // Ignore une progression tardive si l'item a déjà été annulé/retiré entre-temps.
        if (!current || current.state !== "uploading") return;
        this.setItem(id, { ...current, progress: Math.min(100, Math.max(0, percent)) });
      },
      controller.signal
    )
      .then((result) => {
        const current = this.items.get(id);
        if (!current || current.state !== "uploading") return; // annulé entre-temps
        this.setItem(id, { ...current, state: "done", progress: 100, result });
      })
      .catch((err: unknown) => {
        const current = this.items.get(id);
        if (!current) return;
        if (current.state === "cancelled") return; // déjà traité par cancel()
        const message = err instanceof Error ? err.message : "Échec de l'envoi.";
        this.setItem(id, { ...current, state: "error", error: message });
      })
      .finally(() => {
        this.controllers.delete(id);
        this.pump();
      });
  }

  private setItem(id: string, next: UploadItem<TFile, TResult>): void {
    this.items.set(id, next);
    this.emit();
  }

  private emit(): void {
    const snapshot = this.getItems();
    for (const listener of this.listeners) listener(snapshot);
  }
}
