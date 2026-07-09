import { describe, it, expect } from "vitest";
import {
  splitHashtags,
  joinHashtags,
  mergeHashtags,
  applyGroupHashtags,
  isValidDateTimeLocal,
  msToDateTimeLocal,
  computeSpacedTimes,
  validateCard,
  MIN_LEAD_MS,
} from "@/lib/bulk-ui";

describe("splitHashtags", () => {
  it("découpe sur espaces, virgules et retours ligne", () => {
    expect(splitHashtags("pokemon, tcg  boosters\nfr")).toEqual([
      "pokemon",
      "tcg",
      "boosters",
      "fr",
    ]);
  });

  it("retire le # de tête (même multiple) et les vides", () => {
    expect(splitHashtags("#pokemon ##tcg  ,  ")).toEqual(["pokemon", "tcg"]);
  });

  it("renvoie un tableau vide pour une saisie vide ou uniquement des séparateurs", () => {
    expect(splitHashtags("")).toEqual([]);
    expect(splitHashtags("  ,  \n ")).toEqual([]);
  });
});

describe("joinHashtags", () => {
  it("recompose une chaîne éditable séparée par des espaces", () => {
    expect(joinHashtags(["pokemon", "tcg"])).toBe("pokemon tcg");
  });
});

describe("mergeHashtags", () => {
  it("ajoute sans doublon insensible à la casse, en gardant la première graphie", () => {
    expect(mergeHashtags(["Pokemon", "tcg"], ["POKEMON", "fr"])).toEqual([
      "Pokemon",
      "tcg",
      "fr",
    ]);
  });

  it("préserve l'ordre : existants d'abord, nouveaux ensuite", () => {
    expect(mergeHashtags(["a", "b"], ["c", "b", "d"])).toEqual(["a", "b", "c", "d"]);
  });
});

describe("applyGroupHashtags", () => {
  const perCard = [["a"], ["b", "c"], []];

  it("mode replace : chaque carte reçoit exactement la liste commune", () => {
    const result = applyGroupHashtags(perCard, ["x", "y"], "replace");
    expect(result).toEqual([
      ["x", "y"],
      ["x", "y"],
      ["x", "y"],
    ]);
  });

  it("mode append : chaque carte conserve les siens + les communs (dédupliqués)", () => {
    const result = applyGroupHashtags(perCard, ["b", "z"], "append");
    expect(result).toEqual([
      ["a", "b", "z"],
      ["b", "c", "z"],
      ["b", "z"],
    ]);
  });

  it("ne mute pas l'entrée (renvoie de nouveaux tableaux)", () => {
    const input = [["a"]];
    const result = applyGroupHashtags(input, ["b"], "append");
    expect(input).toEqual([["a"]]);
    expect(result).not.toBe(input);
  });
});

describe("isValidDateTimeLocal", () => {
  it("accepte une chaîne datetime-local valide", () => {
    expect(isValidDateTimeLocal("2026-07-09T14:30")).toBe(true);
  });

  it("rejette un mauvais format", () => {
    expect(isValidDateTimeLocal("2026-07-09 14:30")).toBe(false);
    expect(isValidDateTimeLocal("2026-07-09T14:30:00")).toBe(false);
    expect(isValidDateTimeLocal("")).toBe(false);
  });

  it("rejette une date impossible bien que bien formée", () => {
    expect(isValidDateTimeLocal("2026-02-31T10:00")).toBe(false);
    expect(isValidDateTimeLocal("2026-13-01T10:00")).toBe(false);
    expect(isValidDateTimeLocal("2026-07-09T25:00")).toBe(false);
  });
});

describe("computeSpacedTimes", () => {
  it("espace chaque carte de N minutes à partir de l'heure de départ", () => {
    const result = computeSpacedTimes("2026-07-09T10:00", 30, 3);
    expect(result).toEqual({
      times: ["2026-07-09T10:00", "2026-07-09T10:30", "2026-07-09T11:00"],
    });
  });

  it("intervalle 0 : toutes les cartes à la même heure", () => {
    const result = computeSpacedTimes("2026-07-09T10:00", 0, 3);
    expect(result).toEqual({
      times: ["2026-07-09T10:00", "2026-07-09T10:00", "2026-07-09T10:00"],
    });
  });

  it("gère le passage d'heure / de jour", () => {
    const result = computeSpacedTimes("2026-07-09T23:50", 15, 2);
    expect(result).toEqual({
      times: ["2026-07-09T23:50", "2026-07-10T00:05"],
    });
  });

  it("count 0 renvoie un tableau vide", () => {
    expect(computeSpacedTimes("2026-07-09T10:00", 30, 0)).toEqual({ times: [] });
  });

  it("erreur si l'heure de départ est invalide", () => {
    expect(computeSpacedTimes("pas une date", 30, 2)).toEqual({
      error: "Heure de départ invalide.",
    });
  });

  it("erreur si l'intervalle est négatif", () => {
    expect(computeSpacedTimes("2026-07-09T10:00", -5, 2)).toEqual({
      error: "Intervalle invalide (minutes ≥ 0).",
    });
  });

  it("roundtrip msToDateTimeLocal ↔ computeSpacedTimes cohérent", () => {
    const start = "2026-01-15T08:05";
    const [first] = (computeSpacedTimes(start, 10, 1) as { times: string[] }).times;
    expect(first).toBe(start);
    // msToDateTimeLocal d'une date construite localement reproduit bien l'entrée.
    const ms = new Date(2026, 0, 15, 8, 5).getTime();
    expect(msToDateTimeLocal(ms)).toBe(start);
  });
});

describe("validateCard", () => {
  const now = new Date(2026, 6, 9, 10, 0).getTime();
  const future = now + 60 * 60 * 1000; // +1h

  it("valide une carte correcte (IG + légende, futur)", () => {
    expect(
      validateCard(
        {
          mediaCount: 1,
          caption: "Ma légende",
          platforms: { tiktok: true, instagram: true },
          scheduledMs: future,
        },
        now
      )
    ).toBeNull();
  });

  it("refuse sans média", () => {
    expect(
      validateCard(
        { mediaCount: 0, caption: "x", platforms: { tiktok: true, instagram: false }, scheduledMs: future },
        now
      )
    ).toBe("Sélectionnez au moins un média.");
  });

  it("refuse sans plateforme", () => {
    expect(
      validateCard(
        { mediaCount: 1, caption: "x", platforms: { tiktok: false, instagram: false }, scheduledMs: future },
        now
      )
    ).toBe("Choisissez au moins une plateforme.");
  });

  it("refuse une heure trop proche (< marge 2 min)", () => {
    expect(
      validateCard(
        {
          mediaCount: 1,
          caption: "x",
          platforms: { tiktok: true, instagram: false },
          scheduledMs: now + MIN_LEAD_MS - 1000,
        },
        now
      )
    ).toBe("L'heure de publication doit être au moins 2 minutes dans le futur.");
  });

  it("refuse une heure NaN", () => {
    expect(
      validateCard(
        { mediaCount: 1, caption: "x", platforms: { tiktok: true, instagram: false }, scheduledMs: Number.NaN },
        now
      )
    ).toBe("Choisissez une date et une heure de publication.");
  });

  it("refuse une légende vide quand Instagram est ciblé", () => {
    expect(
      validateCard(
        { mediaCount: 1, caption: "   ", platforms: { tiktok: false, instagram: true }, scheduledMs: future },
        now
      )
    ).toBe("Ajoutez une légende (obligatoire pour Instagram).");
  });

  it("autorise une légende vide quand seul TikTok est ciblé", () => {
    expect(
      validateCard(
        { mediaCount: 1, caption: "", platforms: { tiktok: true, instagram: false }, scheduledMs: future },
        now
      )
    ).toBeNull();
  });

  it("refuse une légende trop longue", () => {
    expect(
      validateCard(
        {
          mediaCount: 1,
          caption: "a".repeat(2201),
          platforms: { tiktok: true, instagram: false },
          scheduledMs: future,
        },
        now
      )
    ).toBe("2200 caractères maximum.");
  });
});
