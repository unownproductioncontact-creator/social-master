// Règles pures des statistiques Instagram (CLAUDE.md §43) : droit, lecture des réponses Meta (jeu vide ≠ 0),
// replis de métriques, type de média, cadence de relevé, classement des erreurs, journées Meta (fuseau du
// Pacifique, changements d'heure), affichage.
import { describe, it, expect } from "vitest";
import {
  insightsScopeStatus,
  parseMediaInsights,
  mediaStatsColumns,
  metricAttemptsFor,
  classifyListedMedia,
  refreshIntervalMs,
  statsRefreshDue,
  classifyInsightsError,
  shiftDay,
  accountDaysToFetch,
  metaToday,
  metaDayWindow,
  parseAccountTotals,
  watchTimeSeconds,
  skipRatePercent,
  captionExcerpt,
  REEL_METRICS,
  FEED_METRICS,
} from "@/lib/instagram-stats";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const metaError = (code: number) => new Error(`Graph API Instagram échouée (400): {"error":{"message":"x","type":"OAuthException","code":${code},"fbtrace_id":"A190B"}}`);

describe("droit de lire les statistiques", () => {
  it("liste vide = inconnue (on tente), sinon le scope décide", () => {
    expect(insightsScopeStatus([])).toBe("unknown");
    expect(insightsScopeStatus(["instagram_business_basic", "instagram_business_content_publish"])).toBe("missing");
    expect(insightsScopeStatus(["instagram_business_basic", "instagram_business_manage_insights"])).toBe("granted");
  });
});

describe("lecture des réponses de /{media-id}/insights", () => {
  it("une métrique absente part dans missing, jamais comptée comme 0", () => {
    const json = {
      data: [
        { name: "views", period: "lifetime", values: [{ value: 1520 }] },
        { name: "reach", period: "lifetime", values: [{ value: 980 }] },
        { name: "likes", period: "lifetime", values: [{}] },
        { name: "reels_skip_rate", total_value: { value: 41.5 } },
        { name: "shares", values: [{ value: "12" }] },
      ],
    };
    const { values, missing } = parseMediaInsights(json, REEL_METRICS);
    expect(values).toEqual({ views: 1520, reach: 980, reels_skip_rate: 41.5 });
    expect(missing).toEqual(expect.arrayContaining(["likes", "shares", "comments", "saved"]));
    expect(missing).not.toContain("views");
  });

  it("réponse vide ou illisible : tout manque", () => {
    expect(parseMediaInsights({ data: [] }, FEED_METRICS).missing).toEqual([...FEED_METRICS]);
    expect(parseMediaInsights(null, ["views"]).missing).toEqual(["views"]);
  });

  it("colonnes : entiers arrondis, et SEULEMENT les métriques renvoyées (rien n'est effacé)", () => {
    const cols = mediaStatsColumns({ views: 10.4, ig_reels_avg_watch_time: 5234.6, reels_skip_rate: 0.42, inconnue: 3 });
    expect(cols).toEqual({ views: 10, avgWatchTime: 5234.6, skipRate: 0.42 });
    expect("reach" in cols).toBe(false);
    expect(mediaStatsColumns({})).toEqual({});
  });
});

describe("replis de métriques et type de média", () => {
  it("Reel : complet → sans zapping → fil → base ; fil : fil → base ; Story/pub : rien", () => {
    expect(metricAttemptsFor("REELS")).toHaveLength(4);
    expect(metricAttemptsFor("REELS")![0]).toContain("reels_skip_rate");
    expect(metricAttemptsFor("REELS")![1]).not.toContain("reels_skip_rate");
    expect(metricAttemptsFor("REELS")![1]).toContain("ig_reels_avg_watch_time");
    expect(metricAttemptsFor("FEED")).toHaveLength(2);
    expect(metricAttemptsFor("FEED")![0]).not.toContain("ig_reels_avg_watch_time");
    expect(metricAttemptsFor("STORY")).toBeNull();
    expect(metricAttemptsFor(null)).toBeNull();
  });

  it("ce que Social Master a publié prime ; puis media_product_type ; puis is_shared_to_feed", () => {
    expect(classifyListedMedia({ media_type: "VIDEO" }, "REEL")).toBe("REELS");
    expect(classifyListedMedia({ media_type: "CAROUSEL_ALBUM", media_product_type: "FEED" }, "CAROUSEL")).toBe("FEED");
    expect(classifyListedMedia({ media_type: "VIDEO" }, "STORY")).toBe("STORY");
    expect(classifyListedMedia({ media_type: "VIDEO", media_product_type: "REELS" })).toBe("REELS");
    expect(classifyListedMedia({ media_type: "VIDEO", is_shared_to_feed: false })).toBe("REELS");
    expect(classifyListedMedia({ media_type: "VIDEO" })).toBe("FEED");
    expect(classifyListedMedia({ media_type: "IMAGE" })).toBe("FEED");
    expect(classifyListedMedia({})).toBeNull();
  });
});

describe("cadence de relevé", () => {
  const now = new Date("2026-10-26T12:00:00Z");
  const posted = (ageMs: number) => new Date(now.getTime() - ageMs);

  it("6 h tant qu'un média a moins de 3 jours, puis 1 j, 7 j, 30 j", () => {
    expect(refreshIntervalMs(posted(2 * DAY), now)).toBe(6 * HOUR);
    expect(refreshIntervalMs(posted(10 * DAY), now)).toBe(DAY);
    expect(refreshIntervalMs(posted(60 * DAY), now)).toBe(7 * DAY);
    expect(refreshIntervalMs(posted(400 * DAY), now)).toBe(30 * DAY);
  });

  it("jamais relevé = dû ; marge de 30 min pour un passage toutes les 6 h", () => {
    expect(statsRefreshDue({ postedAt: posted(DAY), statsFetchedAt: null }, now)).toBe(true);
    expect(statsRefreshDue({ postedAt: posted(DAY), statsFetchedAt: posted(5 * HOUR) }, now)).toBe(false);
    expect(statsRefreshDue({ postedAt: posted(DAY), statsFetchedAt: posted(5.75 * HOUR) }, now)).toBe(true);
    expect(statsRefreshDue({ postedAt: posted(60 * DAY), statsFetchedAt: posted(2 * DAY) }, now)).toBe(false);
  });
});

describe("classement des erreurs (jamais de pause du compte)", () => {
  it("limite propre à Instagram (80002, sous-code 2446079) et is_transient", () => {
    expect(classifyInsightsError(metaError(80002)).kind).toBe("rate_limited");
    expect(
      classifyInsightsError(new Error('x: {"error":{"code":4,"error_subcode":2446079,"message":"limit"}}')).kind
    ).toBe("rate_limited");
    expect(
      classifyInsightsError(new Error('x: {"error":{"code":10,"is_transient":true,"message":"temp"}}')).kind
    ).toBe("other");
  });

  it("190 jeton, 3/10/2xx droit, 4/17/32/613 limite, 100 refus, sinon autre", () => {
    expect(classifyInsightsError(metaError(190)).kind).toBe("token");
    expect(classifyInsightsError(metaError(10)).kind).toBe("permission");
    expect(classifyInsightsError(metaError(3)).kind).toBe("permission");
    expect(classifyInsightsError(metaError(200)).kind).toBe("permission");
    expect(classifyInsightsError(metaError(4)).kind).toBe("rate_limited");
    expect(classifyInsightsError(metaError(613)).kind).toBe("rate_limited");
    expect(classifyInsightsError(metaError(100)).kind).toBe("invalid");
    expect(classifyInsightsError(new Error("fetch failed")).kind).toBe("other");
  });

  it("un fbtrace_id contenant « 190 » ne fait pas croire à un jeton mort", () => {
    expect(classifyInsightsError(metaError(100)).kind).toBe("invalid");
  });

  it("corps tronqué : repli sur le champ code", () => {
    expect(classifyInsightsError(new Error('Graph API Instagram échouée (400): {"error":{"code":10,"message":"tronq')).kind).toBe("permission");
  });
});

describe("journées Meta (minuit-minuit heure du Pacifique)", () => {
  it("décalage de date pur", () => {
    expect(shiftDay("2026-03-01", -1)).toBe("2026-02-28");
    expect(shiftDay("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("aujourd'hui côté Meta : à 8 h à Paris, la Californie est encore la veille", () => {
    expect(metaToday(new Date("2026-10-26T07:00:00Z"))).toBe("2026-10-26");
    expect(metaToday(new Date("2026-10-26T06:00:00Z"))).toBe("2026-10-25");
  });

  it("fenêtre d'été 07:00Z, d'hiver 08:00Z, journée de 25 h au changement d'heure", () => {
    const summer = metaDayWindow("2026-07-15");
    expect(new Date(summer.since * 1000).toISOString()).toBe("2026-07-15T07:00:00.000Z");
    expect(summer.until - summer.since).toBe(24 * 3600);
    const winter = metaDayWindow("2026-12-15");
    expect(new Date(winter.since * 1000).toISOString()).toBe("2026-12-15T08:00:00.000Z");
    const dst = metaDayWindow("2026-11-01");
    expect(dst.until - dst.since).toBe(25 * 3600);
  });

  it("89 journées au premier passage, du plus récent au plus ancien ; ensuite les manquantes + les 3 dernières", () => {
    const first = accountDaysToFetch("2026-10-26", new Set());
    expect(first).toHaveLength(89);
    expect(first[0]).toBe("2026-10-25");
    expect(first.at(-1)).toBe("2026-07-29");
    const stored = new Set(first);
    expect(accountDaysToFetch("2026-10-26", stored)).toEqual(["2026-10-25", "2026-10-24", "2026-10-23"]);
    expect(accountDaysToFetch("2026-10-27", stored)).toEqual(["2026-10-26", "2026-10-25", "2026-10-24"]);
  });

  it("totaux du compte : total_value seulement", () => {
    expect(
      parseAccountTotals({
        data: [
          { name: "views", total_value: { value: 3400 } },
          { name: "reach", total_value: { value: 1200 } },
          { name: "likes", total_value: {} },
        ],
      })
    ).toEqual({ views: 3400, reach: 1200 });
  });
});

describe("affichage", () => {
  it("temps de visionnage en secondes (ms supposées)", () => {
    expect(watchTimeSeconds(5234)).toBe(5.2);
    expect(watchTimeSeconds(null)).toBeNull();
  });

  it("taux de zapping : échelle choisie pour tout le compte, jamais valeur par valeur", () => {
    expect(skipRatePercent(0.423, 0.61)).toBe(42.3); // le compte n'a que des fractions
    expect(skipRatePercent(42.3, 61)).toBe(42.3); // échelle 0-100
    expect(skipRatePercent(0.8, 61)).toBe(0.8); // 0,8 % reste 0,8 % sur un compte en 0-100
    expect(skipRatePercent(0.423)).toBe(42.3); // sans référence : la valeur elle-même
    expect(skipRatePercent(undefined, 50)).toBeNull();
  });

  it("légende sur une ligne, raccourcie", () => {
    expect(captionExcerpt("Ligne 1\nLigne 2", 90)).toBe("Ligne 1 Ligne 2");
    expect(captionExcerpt("x".repeat(100), 10)).toBe(`${"x".repeat(9)}…`);
    expect(captionExcerpt(null)).toBeNull();
  });
});
