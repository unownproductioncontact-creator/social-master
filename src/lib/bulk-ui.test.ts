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
  localToDate,
  localToMs,
  localToIso,
  dateToLocal,
  effectiveTiktokTimeMs,
  relevantTimeFields,
  cardQuietWindowFields,
  type CardTimeFields,
} from "@/lib/bulk-ui";

const TZ = "Europe/Paris";

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

  it("autorise une carte YouTube seule (aucune règle de légende YouTube en masse)", () => {
    expect(
      validateCard(
        {
          mediaCount: 1,
          caption: "",
          platforms: { tiktok: false, instagram: false, youtube: true },
          scheduledMs: future,
        },
        now
      )
    ).toBeNull();
  });

  it("accepte YouTube comme unique plateforme pour la règle « au moins une plateforme »", () => {
    // Sans aucune des trois → refus ; YouTube seul suffit à lever ce refus.
    expect(
      validateCard(
        {
          mediaCount: 1,
          caption: "x",
          platforms: { tiktok: false, instagram: false, youtube: false },
          scheduledMs: future,
        },
        now
      )
    ).toBe("Choisissez au moins une plateforme.");
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

describe("localToDate / localToMs / localToIso", () => {
  it("convertit une chaîne datetime-local en instant UTC correct (heure d'été, CEST/UTC+2)", () => {
    const date = localToDate("2026-07-09T14:30", TZ);
    expect(date?.toISOString()).toBe("2026-07-09T12:30:00.000Z");
  });

  it("convertit une chaîne datetime-local en instant UTC correct (heure d'hiver, CET/UTC+1)", () => {
    const date = localToDate("2026-01-15T23:30", TZ);
    expect(date?.toISOString()).toBe("2026-01-15T22:30:00.000Z");
  });

  it("localToMs et localToIso s'accordent avec localToDate", () => {
    const value = "2026-07-09T14:30";
    const date = localToDate(value, TZ)!;
    expect(localToMs(value, TZ)).toBe(date.getTime());
    expect(localToIso(value, TZ)).toBe(date.toISOString());
  });

  it("renvoie null/NaN pour une chaîne invalide", () => {
    expect(localToDate("pas une date", TZ)).toBeNull();
    expect(localToMs("pas une date", TZ)).toBeNaN();
    expect(localToIso("pas une date", TZ)).toBeNull();
    expect(localToDate("2026-02-31T10:00", TZ)).toBeNull();
  });

  it("un même instant datetime-local donne une conversion différente selon le fuseau", () => {
    const paris = localToDate("2026-07-09T14:30", "Europe/Paris")!;
    const tokyo = localToDate("2026-07-09T14:30", "Asia/Tokyo")!;
    expect(paris.getTime()).not.toBe(tokyo.getTime());
  });
});

describe("dateToLocal", () => {
  it("formate une Date UTC en chaîne datetime-local murale dans le fuseau donné", () => {
    expect(dateToLocal(new Date("2026-07-15T21:30:00.000Z"), TZ)).toBe("2026-07-15T23:30");
  });

  it("fait l'aller-retour avec localToDate", () => {
    const value = "2026-01-15T08:05";
    const date = localToDate(value, TZ)!;
    expect(dateToLocal(date, TZ)).toBe(value);
  });
});

describe("effectiveTiktokTimeMs", () => {
  const base: CardTimeFields = {
    platforms: { tiktok: true, instagram: true },
    dateTime: "2026-07-09T10:00",
    tiktokTime: "2026-07-09T09:00",
    instagramTime: "2026-07-09T11:00",
  };

  it("mode offset : utilise dateTime (horaire de base)", () => {
    expect(effectiveTiktokTimeMs(base, "offset", TZ)).toBe(localToMs("2026-07-09T10:00", TZ));
  });

  it("mode simultané : utilise dateTime aussi", () => {
    expect(effectiveTiktokTimeMs(base, "simultaneous", TZ)).toBe(localToMs("2026-07-09T10:00", TZ));
  });

  it("mode custom : utilise tiktokTime (pas dateTime)", () => {
    expect(effectiveTiktokTimeMs(base, "custom", TZ)).toBe(localToMs("2026-07-09T09:00", TZ));
  });

  it("renvoie null si la carte ne cible pas TikTok", () => {
    const card: CardTimeFields = { ...base, platforms: { tiktok: false, instagram: true } };
    expect(effectiveTiktokTimeMs(card, "offset", TZ)).toBeNull();
  });

  it("renvoie null si l'horaire pertinent est invalide/vide", () => {
    const card: CardTimeFields = { ...base, tiktokTime: "" };
    expect(effectiveTiktokTimeMs(card, "custom", TZ)).toBeNull();
  });
});

describe("relevantTimeFields", () => {
  const base: CardTimeFields = {
    platforms: { tiktok: true, instagram: true },
    dateTime: "2026-07-09T10:00",
    tiktokTime: "2026-07-09T09:00",
    instagramTime: "2026-07-09T11:00",
  };

  it("offset/simultané : un seul champ partagé (dateTime) si au moins une plateforme est cochée", () => {
    expect(relevantTimeFields(base, "offset")).toEqual([{ field: "dateTime", value: "2026-07-09T10:00" }]);
    expect(relevantTimeFields(base, "simultaneous")).toEqual([
      { field: "dateTime", value: "2026-07-09T10:00" },
    ]);
  });

  it("offset : dateTime absent si AUCUNE plateforme n'est cochée", () => {
    const card: CardTimeFields = { ...base, platforms: { tiktok: false, instagram: false } };
    expect(relevantTimeFields(card, "offset")).toEqual([]);
  });

  it("custom : un champ par plateforme cochée", () => {
    expect(relevantTimeFields(base, "custom")).toEqual([
      { field: "tiktokTime", value: "2026-07-09T09:00" },
      { field: "instagramTime", value: "2026-07-09T11:00" },
    ]);
  });

  it("custom : seulement le champ de la plateforme cochée", () => {
    const card: CardTimeFields = { ...base, platforms: { tiktok: true, instagram: false } };
    expect(relevantTimeFields(card, "custom")).toEqual([
      { field: "tiktokTime", value: "2026-07-09T09:00" },
    ]);
  });

  it("custom : inclut youtubeTime quand YouTube est coché (symétrique de tiktok/instagram)", () => {
    const card: CardTimeFields = {
      platforms: { tiktok: true, instagram: false, youtube: true },
      dateTime: "2026-07-09T10:00",
      tiktokTime: "2026-07-09T09:00",
      instagramTime: "2026-07-09T11:00",
      youtubeTime: "2026-07-09T12:00",
    };
    expect(relevantTimeFields(card, "custom")).toEqual([
      { field: "tiktokTime", value: "2026-07-09T09:00" },
      { field: "youtubeTime", value: "2026-07-09T12:00" },
    ]);
  });

  it("offset/simultané : dateTime reste pertinent pour une carte YouTube seule", () => {
    const card: CardTimeFields = {
      platforms: { tiktok: false, instagram: false, youtube: true },
      dateTime: "2026-07-09T10:00",
      tiktokTime: "",
      instagramTime: "",
      youtubeTime: "",
    };
    expect(relevantTimeFields(card, "offset")).toEqual([
      { field: "dateTime", value: "2026-07-09T10:00" },
    ]);
  });
});

describe("cardQuietWindowFields", () => {
  it("signale dateTime quand il tombe dans la fenêtre morte (offset/simultané)", () => {
    const card: CardTimeFields = {
      platforms: { tiktok: true, instagram: false },
      dateTime: "2026-07-15T23:30",
      tiktokTime: "2026-07-15T23:30",
      instagramTime: "2026-07-15T23:30",
    };
    expect(cardQuietWindowFields(card, "offset", TZ)).toEqual([
      { field: "dateTime", value: "2026-07-15T23:30" },
    ]);
  });

  it("ne signale rien quand l'horaire est hors fenêtre morte", () => {
    const card: CardTimeFields = {
      platforms: { tiktok: true, instagram: true },
      dateTime: "2026-07-15T10:00",
      tiktokTime: "2026-07-15T10:00",
      instagramTime: "2026-07-15T10:00",
    };
    expect(cardQuietWindowFields(card, "offset", TZ)).toEqual([]);
  });

  it("mode custom : ne signale que le champ concerné, pas les deux", () => {
    const card: CardTimeFields = {
      platforms: { tiktok: true, instagram: true },
      dateTime: "2026-07-15T10:00",
      tiktokTime: "2026-07-15T02:00",
      instagramTime: "2026-07-15T10:00",
    };
    expect(cardQuietWindowFields(card, "custom", TZ)).toEqual([
      { field: "tiktokTime", value: "2026-07-15T02:00" },
    ]);
  });

  it("un champ invalide n'est jamais signalé", () => {
    const card: CardTimeFields = {
      platforms: { tiktok: true, instagram: false },
      dateTime: "",
      tiktokTime: "",
      instagramTime: "",
    };
    expect(cardQuietWindowFields(card, "offset", TZ)).toEqual([]);
  });

  it("mode custom : signale youtubeTime quand il tombe dans la fenêtre morte", () => {
    const card: CardTimeFields = {
      platforms: { tiktok: false, instagram: false, youtube: true },
      dateTime: "2026-07-15T10:00",
      tiktokTime: "",
      instagramTime: "",
      youtubeTime: "2026-07-15T23:30",
    };
    expect(cardQuietWindowFields(card, "custom", TZ)).toEqual([
      { field: "youtubeTime", value: "2026-07-15T23:30" },
    ]);
  });
});
