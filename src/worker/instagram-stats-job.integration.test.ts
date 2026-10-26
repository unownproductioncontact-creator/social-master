// Test d'intégration du relevé des statistiques Instagram (CLAUDE.md §43) : vraies requêtes Prisma contre la
// base de dev locale, API Instagram simulée (fetch). On vérifie : premier relevé complet (liste paginée, type
// connu par Social Master, repli de métriques, Stories ignorées, 89 journées), passage suivant qui ne relit
// que le nécessaire, lecture pour le connecteur et les pages, droit refusé SANS pause du compte, scope absent
// sans aucun appel, replis des champs de liste et des métriques du compte, limite d'appels, erreurs
// passagères (rien n'est repoussé), réponse vide (rien n'est effacé), reprise d'une liste interrompue, refus
// sur un seul média, cron qui crée un relevé par compte.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

vi.mock("@/lib/crypto", () => ({ decryptToken: (v: string) => v, encryptToken: (v: string) => v }));

const { db } = await import("@/lib/db");
const { runInstagramStats } = await import("@/worker/instagram-stats-job");
const { getInstagramStatsForUser, getInstagramStatsForTarget } = await import("@/lib/instagram-stats-service");

const TEST_EMAIL = "vitest-instagram-stats@test.local";
const SCOPES = ["instagram_business_basic", "instagram_business_content_publish", "instagram_business_manage_insights"];
const DAY = 86_400_000;

let userId: string;
let calls: URL[];
type Reply = { status?: number; body: unknown };
let handler: (url: URL) => Reply;

const metaError = (code: number): Reply => ({ status: 400, body: { error: { message: "refus", type: "OAuthException", code, fbtrace_id: "A190" } } });
const iso = (ageMs: number) => new Date(Date.now() - ageMs).toISOString().replace(/\.\d{3}Z$/, "+0000");

function insightsFor(metrics: string[], values: Record<string, number>) {
  return { data: metrics.filter((m) => m in values).map((m) => ({ name: m, period: "lifetime", values: [{ value: values[m] }] })) };
}

/** Meta par défaut : 2 pages de médias, statistiques pour tous, journées du compte. */
function defaultMeta(igUserId: string, overrides: { mediaInsights?: (mediaId: string, metrics: string[]) => Reply } = {}) {
  return (url: URL): Reply => {
    if (url.pathname === `/v25.0/${igUserId}/media`) {
      // Comme Meta : seuls les champs demandés reviennent.
      const fields = new Set((url.searchParams.get("fields") ?? "id").split(","));
      const pick = (items: Array<Record<string, unknown>>) =>
        items.map((item) => Object.fromEntries(Object.entries(item).filter(([k]) => fields.has(k))));
      if (url.searchParams.get("after") === "c1") {
        return { body: { data: pick([{ id: "m_story", media_type: "VIDEO", media_product_type: "STORY", timestamp: iso(3 * DAY) }]), paging: {} } };
      }
      return {
        body: {
          data: pick([
            // Publié par Social Master : ni media_product_type ni is_shared_to_feed, son type vient de la base.
            { id: `${igUserId}_sm`, media_type: "VIDEO", timestamp: iso(DAY), permalink: "https://www.instagram.com/reel/SMCODE/" },
            { id: `${igUserId}_reel`, media_type: "VIDEO", media_product_type: "REELS", timestamp: iso(2 * DAY), permalink: "https://www.instagram.com/reel/R2/", caption: "Reel deux" },
            { id: `${igUserId}_feed`, media_type: "IMAGE", media_product_type: "FEED", timestamp: iso(40 * DAY), permalink: "https://www.instagram.com/p/F1/", caption: "Photo" },
          ]),
          paging: { next: "https://next", cursors: { after: "c1" } },
        },
      };
    }
    const media = url.pathname.match(/^\/v25\.0\/([^/]+)\/insights$/);
    if (media && media[1] !== igUserId) {
      const metrics = (url.searchParams.get("metric") ?? "").split(",");
      if (overrides.mediaInsights) return overrides.mediaInsights(media[1], metrics);
      const base = { views: 1000, reach: 700, likes: 80, shares: 12, saved: 9, total_interactions: 101, ig_reels_avg_watch_time: 6400, ig_reels_video_view_total_time: 6_400_000, reels_skip_rate: 38.5 };
      if (media[1] === `${igUserId}_reel` && metrics.includes("reels_skip_rate")) return metaError(100); // métrique refusée → repli
      const bump = media[1] === `${igUserId}_sm` ? 5000 : 0;
      return { body: insightsFor(metrics, Object.fromEntries(Object.entries(base).map(([k, v]) => [k, k === "views" ? v + bump : v]))) };
    }
    if (url.pathname === `/v25.0/${igUserId}/insights`) {
      const since = Number(url.searchParams.get("since"));
      return { body: { data: [{ name: "views", total_value: { value: 100 + ((since / 86400) % 50) } }, { name: "reach", total_value: { value: 40 } }] } };
    }
    return { status: 404, body: { error: { code: 803, message: `inattendu ${url.pathname}` } } };
  };
}

async function account(igUserId: string, grantedScopes = SCOPES) {
  return db.socialAccount.create({
    data: { userId, platform: "INSTAGRAM", platformAccountId: igUserId, username: "moha_test", accessTokenEnc: "tok", grantedScopes },
  });
}

async function publishedReel(socialAccountId: string, mediaId: string) {
  const post = await db.post.create({ data: { userId, caption: "Le Reel de Social Master", status: "PUBLISHED" } });
  await db.postTarget.create({
    data: { postId: post.id, socialAccountId, platform: "INSTAGRAM", contentType: "REEL", status: "PUBLISHED", platformPostId: mediaId },
  });
  return post.id;
}

beforeAll(async () => {
  await db.user.deleteMany({ where: { email: TEST_EMAIL } });
  userId = (await db.user.create({ data: { email: TEST_EMAIL, passwordHash: "x", name: "Vitest" } })).id;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = new URL(String(input));
      calls.push(url);
      const reply = handler(url);
      return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: { "content-type": "application/json" } });
    })
  );
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await db.user.deleteMany({ where: { email: TEST_EMAIL } });
});

beforeEach(() => {
  calls = [];
});

describe("premier relevé puis passage suivant", () => {
  it("liste, statistiques, journées ; puis seulement le nécessaire", async () => {
    const acc = await account("ig-stats-1");
    const postId = await publishedReel(acc.id, "ig-stats-1_sm");
    handler = defaultMeta("ig-stats-1");

    const [first] = await runInstagramStats({ socialAccountId: acc.id });
    expect(first).toMatchObject({ ok: true, listFields: "full", accountMetrics: "full", mediaListed: 4, mediaUpdated: 3, daysUpdated: 89, historyComplete: true });

    const rows = await db.instagramMedia.findMany({ where: { socialAccountId: acc.id }, orderBy: { mediaId: "asc" } });
    const byId = Object.fromEntries(rows.map((r) => [r.mediaId, r]));
    expect(byId["ig-stats-1_sm"].mediaProductType).toBe("REELS"); // type connu par Social Master
    expect(byId["ig-stats-1_sm"]).toMatchObject({ views: 6000, reach: 700, avgWatchTime: 6400, skipRate: 38.5, statsError: null });
    expect(byId["ig-stats-1_sm"].missingMetrics).toEqual(["comments"]); // absente = pas un zéro
    expect(byId["ig-stats-1_sm"].comments).toBeNull();
    // Taux de zapping refusé sur ce Reel → repli sans lui : le temps de visionnage est gardé.
    expect(byId["ig-stats-1_reel"]).toMatchObject({ views: 1000, avgWatchTime: 6400, skipRate: null, statsError: null });
    expect(calls.filter((u) => u.pathname === "/v25.0/ig-stats-1_reel/insights")).toHaveLength(2);
    // Story listée mais jamais relevée.
    expect(byId["m_story"]).toMatchObject({ mediaProductType: "STORY", statsFetchedAt: null });
    expect(calls.some((u) => u.pathname === "/v25.0/m_story/insights")).toBe(false);

    expect(await db.instagramMediaSnapshot.count({ where: { instagramMedia: { socialAccountId: acc.id } } })).toBe(3);
    expect(await db.instagramAccountDay.count({ where: { socialAccountId: acc.id } })).toBe(89);
    const saved = await db.socialAccount.findUniqueOrThrow({ where: { id: acc.id } });
    expect((saved.metadata as { instagramStats?: { ok: boolean } }).instagramStats?.ok).toBe(true);

    // Lecture pour le connecteur et les pages.
    const stats = await getInstagramStatsForUser(userId, { days: 30, sort: "views", history: true });
    expect(stats.account?.scope).toBe("granted");
    expect(stats.media.map((m) => m.mediaId)).toEqual(["ig-stats-1_sm", "ig-stats-1_reel"]); // la photo a 40 j
    expect(stats.media[0]).toMatchObject({ postId, caption: "Le Reel de Social Master", avgWatchSeconds: 6.4, skipRatePct: 38.5 });
    expect(stats.media[0].history).toHaveLength(1);
    expect(stats.totals?.views7d.daysWithData).toBe(7);
    expect(stats.totals?.views30d.daysWithData).toBe(30);
    expect(stats.mediaTotal).toBe(2);
    expect((await getInstagramStatsForUser(userId, { days: 7 })).totals?.views30d.daysWithData).toBe(30); // indépendant de days
    expect(await getInstagramStatsForTarget(acc.id, "ig-stats-1_sm")).toMatchObject({ views: 6000 });

    // Passage suivant juste après : la liste s'arrête aux médias de plus de 30 j, rien n'est dû, 3 journées relues.
    calls = [];
    const [second] = await runInstagramStats({ socialAccountId: acc.id });
    expect(second).toMatchObject({ ok: true, mediaUpdated: 0, daysUpdated: 3 });
    expect(calls.filter((u) => u.pathname.endsWith("/media"))).toHaveLength(1);
    expect(await db.instagramMediaSnapshot.count({ where: { instagramMedia: { socialAccountId: acc.id } } })).toBe(3);
  });
});

describe("refus et replis", () => {
  it("droit refusé : relevé arrêté, compte TOUJOURS actif, erreur brute journalisée", async () => {
    const acc = await account("ig-stats-2");
    handler = (url) => (url.pathname.endsWith("/media") ? metaError(10) : defaultMeta("ig-stats-2")(url));
    const [report] = await runInstagramStats({ socialAccountId: acc.id });
    expect(report).toMatchObject({ ok: false, errorKind: "permission" });
    expect(calls.some((u) => u.pathname.endsWith("/insights"))).toBe(false);
    expect((await db.socialAccount.findUniqueOrThrow({ where: { id: acc.id } })).status).toBe("ACTIVE");
    const log = await db.activityLog.findFirst({ where: { entityId: acc.id, action: "instagram_stats_failed" } });
    expect((log?.detail as { rawError?: string })?.rawError).toContain('"code":10');
  });

  it("scope absent : aucun appel, état « missing_scope »", async () => {
    const acc = await account("ig-stats-3", ["instagram_business_basic", "instagram_business_content_publish"]);
    handler = defaultMeta("ig-stats-3");
    const [report] = await runInstagramStats({ socialAccountId: acc.id });
    expect(report).toMatchObject({ ok: false, errorKind: "missing_scope" });
    expect(calls).toHaveLength(0);
  });

  it("champs de liste refusés → repli ; métriques du compte refusées → vues et portée (retentés à chaque passage)", async () => {
    const acc = await account("ig-stats-4");
    const meta = defaultMeta("ig-stats-4");
    handler = (url) => {
      if (url.pathname.endsWith("/media") && url.searchParams.get("fields")?.includes("media_product_type")) return metaError(100);
      if (url.pathname === "/v25.0/ig-stats-4/insights" && url.searchParams.get("metric")!.includes("accounts_engaged")) return metaError(100);
      return meta(url);
    };
    const [report] = await runInstagramStats({ socialAccountId: acc.id });
    expect(report).toMatchObject({ ok: true, listFields: "fallback", accountMetrics: "fallback", daysUpdated: 89 });
    // Sans media_product_type : Reel déclaré par Meta perdu → la vidéo sans is_shared_to_feed passe en « fil ».
    const reel = await db.instagramMedia.findFirstOrThrow({ where: { socialAccountId: acc.id, mediaId: "ig-stats-4_reel" } });
    expect(reel.mediaProductType).toBe("FEED");
    const day = await db.instagramAccountDay.findFirstOrThrow({ where: { socialAccountId: acc.id } });
    expect(day.views).not.toBeNull();

    // Passage suivant : la version complète est retentée d'abord (un refus passager ne dégrade pas pour toujours).
    calls = [];
    await runInstagramStats({ socialAccountId: acc.id });
    expect(calls.find((u) => u.pathname.endsWith("/media"))!.searchParams.get("fields")).toContain("media_product_type");
    expect(calls.find((u) => u.pathname === "/v25.0/ig-stats-4/insights")!.searchParams.get("metric")).toContain("accounts_engaged");
  });

  it("limite d'appels : arrêt propre, reste en attente pour le passage suivant", async () => {
    const acc = await account("ig-stats-5");
    handler = defaultMeta("ig-stats-5", { mediaInsights: () => metaError(4) });
    const [report] = await runInstagramStats({ socialAccountId: acc.id });
    expect(report).toMatchObject({ ok: false, errorKind: "rate_limited", daysUpdated: 89, mediaUpdated: 0, mediaPending: 3 });
    expect(calls.filter((u) => /\/ig-stats-5_\w+\/insights$/.test(u.pathname))).toHaveLength(1); // arrêt au 1er refus
  });

  it("erreurs passagères : 3 de suite arrêtent la phase, rien n'est repoussé, erreur brute journalisée", async () => {
    const acc = await account("ig-stats-6");
    handler = defaultMeta("ig-stats-6", { mediaInsights: () => ({ status: 500, body: { error: { code: 2, message: "Service temporarily unavailable" } } }) });
    const [report] = await runInstagramStats({ socialAccountId: acc.id });
    expect(report).toMatchObject({ ok: false, errorKind: "other", mediaUpdated: 0 });
    const media = await db.instagramMedia.findMany({ where: { socialAccountId: acc.id, mediaProductType: { in: ["REELS", "FEED"] } } });
    expect(media.every((m) => m.statsFetchedAt === null)).toBe(true); // retentés au passage suivant
    expect(media.every((m) => m.statsError?.includes("illisibles"))).toBe(true);
    const log = await db.activityLog.findFirst({ where: { entityId: acc.id, action: "instagram_stats_failed" } });
    expect((log?.detail as { kind?: string })?.kind).toBe("media");
  });

  it("réponse vide de Meta : les dernières valeurs connues sont gardées, relevé retenté", async () => {
    const acc = await account("ig-stats-7");
    handler = defaultMeta("ig-stats-7");
    await runInstagramStats({ socialAccountId: acc.id });
    const before = await db.instagramMedia.findFirstOrThrow({ where: { socialAccountId: acc.id, mediaId: "ig-stats-7_feed" } });
    expect(before.views).toBe(1000);
    // Relevé dû de nouveau, et Meta ne renvoie plus rien.
    await db.instagramMedia.update({ where: { id: before.id }, data: { statsFetchedAt: new Date(Date.now() - 40 * DAY) } });
    handler = defaultMeta("ig-stats-7", { mediaInsights: () => ({ body: { data: [] } }) });
    await runInstagramStats({ socialAccountId: acc.id });
    const after = await db.instagramMedia.findFirstOrThrow({ where: { id: before.id } });
    expect(after).toMatchObject({ views: 1000, reach: 700 });
    expect(after.statsError).toContain("aucune donnée");
    expect(after.statsFetchedAt!.getTime()).toBeLessThan(Date.now() - 39 * DAY); // pas repoussé
  });

  it("liste interrompue au premier relevé : reprise complète au passage suivant", async () => {
    const acc = await account("ig-stats-8");
    const meta = defaultMeta("ig-stats-8");
    handler = (url) => (url.pathname.endsWith("/media") && url.searchParams.get("after") === "c1" ? { status: 500, body: { error: { code: 1 } } } : meta(url));
    const [first] = await runInstagramStats({ socialAccountId: acc.id });
    expect(first).toMatchObject({ ok: false, historyComplete: false });
    expect(await db.instagramMedia.count({ where: { socialAccountId: acc.id } })).toBe(3);

    handler = meta;
    calls = [];
    const [second] = await runInstagramStats({ socialAccountId: acc.id });
    expect(second).toMatchObject({ historyComplete: true });
    expect(calls.filter((u) => u.pathname.endsWith("/media"))).toHaveLength(2); // liste complète reprise
    expect(await db.instagramMedia.count({ where: { socialAccountId: acc.id } })).toBe(4);
  });

  it("refus de droit sur UN média alors que le droit est prouvé : seul ce média est noté", async () => {
    const acc = await account("ig-stats-9");
    const meta = defaultMeta("ig-stats-9");
    handler = (url) => (url.pathname === "/v25.0/ig-stats-9_feed/insights" ? metaError(10) : meta(url));
    const [report] = await runInstagramStats({ socialAccountId: acc.id });
    expect(report).toMatchObject({ ok: true, mediaUpdated: 2 });
    const feed = await db.instagramMedia.findFirstOrThrow({ where: { socialAccountId: acc.id, mediaId: "ig-stats-9_feed" } });
    expect(feed.statsError).toContain("ne fournit pas");
    expect(feed.statsFetchedAt).not.toBeNull(); // refus définitif : repoussé à sa cadence
  });

  it("cron : un relevé demandé par compte Instagram actif", async () => {
    const acc = await account("ig-stats-10");
    const enqueue = vi.fn(async () => true);
    expect(await runInstagramStats({}, new Date(), enqueue)).toEqual([]);
    expect(enqueue).toHaveBeenCalledWith(acc.id);
    expect(calls).toHaveLength(0); // aucun appel à Meta dans le job du cron
  });
});
