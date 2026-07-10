import { describe, it, expect, beforeEach } from "vitest";
import { getLastUsed, rememberHashtags, rememberScheduleHour, truncatePreview } from "@/lib/last-used";

// L'environnement Vitest de ce projet est "node" (vitest.config.ts) : pas de `localStorage` global par
// défaut (contrairement à jsdom/un navigateur). On installe un mock en mémoire minimal avant chaque
// test pour exercer le chemin heureux, et on le retire pour exercer la dégradation silencieuse
// (mode privé strict / SSR, où `localStorage` n'existe pas du tout — cf. le commentaire d'en-tête de
// last-used.ts).
class MemoryStorage implements Storage {
  private store = new Map<string, string>();
  get length() {
    return this.store.size;
  }
  clear() {
    this.store.clear();
  }
  getItem(key: string) {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  key(index: number) {
    return Array.from(this.store.keys())[index] ?? null;
  }
  removeItem(key: string) {
    this.store.delete(key);
  }
  setItem(key: string, value: string) {
    this.store.set(key, value);
  }
}

beforeEach(() => {
  Object.defineProperty(globalThis, "localStorage", {
    value: new MemoryStorage(),
    writable: true,
    configurable: true,
  });
});

describe("getLastUsed", () => {
  it("renvoie null quand rien n'a encore été mémorisé", () => {
    expect(getLastUsed()).toBeNull();
  });

  it("renvoie les valeurs mémorisées après rememberHashtags/rememberScheduleHour", () => {
    rememberHashtags("pokemon tcg boosters");
    rememberScheduleHour("18:30");
    expect(getLastUsed()).toEqual({ hashtags: "pokemon tcg boosters", scheduleHour: "18:30" });
  });

  it("se dégrade en null si localStorage est indisponible (mode privé strict / SSR)", () => {
    // @ts-expect-error suppression volontaire pour simuler l'absence totale de localStorage
    delete globalThis.localStorage;
    expect(() => getLastUsed()).not.toThrow();
    expect(getLastUsed()).toBeNull();
  });

  it("ignore une entrée localStorage corrompue (JSON invalide) sans jeter", () => {
    localStorage.setItem("sm-last-used-v1", "{ceci n'est pas du json");
    expect(getLastUsed()).toBeNull();
  });

  it("ignore un scheduleHour mal formé stocké manuellement, garde le hashtags valide à côté", () => {
    localStorage.setItem("sm-last-used-v1", JSON.stringify({ hashtags: "abc", scheduleHour: "25:99" }));
    expect(getLastUsed()).toEqual({ hashtags: "abc" });
  });
});

describe("rememberHashtags", () => {
  it("ignore une chaîne vide (n'écrase pas une valeur déjà mémorisée)", () => {
    rememberHashtags("pokemon tcg");
    rememberHashtags("");
    expect(getLastUsed()).toEqual({ hashtags: "pokemon tcg" });
  });

  it("ignore une chaîne blanche (espaces uniquement)", () => {
    rememberHashtags("   ");
    expect(getLastUsed()).toBeNull();
  });

  it("trim les espaces de tête/fin avant de mémoriser", () => {
    rememberHashtags("  pokemon tcg boosters  ");
    expect(getLastUsed()?.hashtags).toBe("pokemon tcg boosters");
  });

  it("remplace la valeur précédente à chaque nouvel appel", () => {
    rememberHashtags("premier lot");
    rememberHashtags("second lot");
    expect(getLastUsed()?.hashtags).toBe("second lot");
  });

  it("ne touche pas à un scheduleHour déjà mémorisé", () => {
    rememberScheduleHour("09:00");
    rememberHashtags("pokemon tcg");
    expect(getLastUsed()).toEqual({ hashtags: "pokemon tcg", scheduleHour: "09:00" });
  });

  it("ne jette pas si localStorage est indisponible", () => {
    // @ts-expect-error suppression volontaire pour simuler l'absence totale de localStorage
    delete globalThis.localStorage;
    expect(() => rememberHashtags("pokemon tcg")).not.toThrow();
  });
});

describe("rememberScheduleHour", () => {
  it("accepte un format HH:mm valide (bornes 00:00 et 23:59)", () => {
    rememberScheduleHour("00:00");
    expect(getLastUsed()?.scheduleHour).toBe("00:00");
    rememberScheduleHour("23:59");
    expect(getLastUsed()?.scheduleHour).toBe("23:59");
  });

  it("ignore silencieusement un format invalide (heure/minute hors bornes, ou mal formé)", () => {
    rememberScheduleHour("24:00");
    expect(getLastUsed()).toBeNull();
    rememberScheduleHour("12:60");
    expect(getLastUsed()).toBeNull();
    rememberScheduleHour("18h30");
    expect(getLastUsed()).toBeNull();
    rememberScheduleHour("");
    expect(getLastUsed()).toBeNull();
  });

  it("ne touche pas à un hashtags déjà mémorisé", () => {
    rememberHashtags("pokemon tcg");
    rememberScheduleHour("18:00");
    expect(getLastUsed()).toEqual({ hashtags: "pokemon tcg", scheduleHour: "18:00" });
  });

  it("ne jette pas si localStorage est indisponible", () => {
    // @ts-expect-error suppression volontaire pour simuler l'absence totale de localStorage
    delete globalThis.localStorage;
    expect(() => rememberScheduleHour("18:00")).not.toThrow();
  });
});

describe("truncatePreview", () => {
  it("renvoie le texte inchangé s'il est déjà assez court", () => {
    expect(truncatePreview("pokemon tcg boosters", 60)).toBe("pokemon tcg boosters");
  });

  it("tronque et ajoute une ellipse au-delà de la longueur maximale", () => {
    const long = "a".repeat(80);
    const preview = truncatePreview(long, 60);
    expect(preview).toHaveLength(61); // 60 caractères + « … »
    expect(preview.endsWith("…")).toBe(true);
    expect(preview.startsWith("a".repeat(60))).toBe(true);
  });

  it("utilise 60 comme longueur par défaut", () => {
    const long = "b".repeat(100);
    expect(truncatePreview(long)).toBe(`${"b".repeat(60)}…`);
  });
});
