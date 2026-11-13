// Test d'intégration de plusieurs comptes par réseau (CLAUDE.md §44) : vraies requêtes Prisma contre la base
// de dev locale, pg-boss simulé. On vérifie : compte principal par défaut, choix par identifiant (composer) et
// par nom (connecteur), compte gardé d'une modification à l'autre, désignation inconnue refusée sans rien
// enregistrer, plafond TikTok de 5 brouillons compté PAR compte, statistiques Instagram du bon compte.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const boss = { send: vi.fn(async () => "job-id"), cancel: vi.fn(async () => {}) };
vi.mock("@/worker/boss", () => ({
  PUBLISH_QUEUE: "publish",
  YOUTUBE_THUMBNAIL_QUEUE: "youtube-thumbnail",
  YOUTUBE_PUBLICATION_QUEUE: "youtube-publication",
  MEDIA_IMPORT_QUEUE: "media-import",
  getBoss: () => boss,
  dbFromPrismaTx: vi.fn(),
}));

const { db } = await import("@/lib/db");
const { saveDraftForUser, schedulePostForUser } = await import("@/lib/post-service");
const { getInstagramStatsForUser } = await import("@/lib/instagram-stats-service");
const { formatInTimeZone } = await import("date-fns-tz");

const TEST_EMAIL = "vitest-multi-account@test.local";
const HOUR = 3_600_000;
let userId: string;
let videoId: string;
const ids: Record<string, string> = {};

async function account(key: string, platform: "YOUTUBE" | "TIKTOK" | "INSTAGRAM", username: string, label: string | null, createdAt: string) {
  ids[key] = (
    await db.socialAccount.create({
      data: {
        userId,
        platform,
        platformAccountId: `${key}_${userId}`,
        username,
        label,
        accessTokenEnc: "x",
        createdAt: new Date(createdAt),
        ...(platform === "INSTAGRAM" ? { grantedScopes: ["instagram_business_basic", "instagram_business_manage_insights"] } : {}),
      },
    })
  ).id;
}

const shortPost = (extra: Record<string, unknown> = {}) => ({
  caption: "Un clip",
  hashtags: [],
  mediaAssetIds: [videoId],
  targetInstagram: false,
  targetInstagramStory: false,
  targetTiktok: true,
  targetYoutube: true,
  ...extra,
});

const targetAccount = async (postId: string, platform: "YOUTUBE" | "TIKTOK") =>
  (await db.postTarget.findFirstOrThrow({ where: { postId, platform } })).socialAccountId;
const local = (d: Date) => formatInTimeZone(d, "Europe/Paris", "yyyy-MM-dd'T'HH:mm");

beforeAll(async () => {
  await db.user.deleteMany({ where: { email: TEST_EMAIL } });
  userId = (await db.user.create({ data: { email: TEST_EMAIL, passwordHash: "x", name: "Vitest" } })).id;
  // Créés dans le désordre : le principal est le plus ANCIEN, pas le premier créé en base.
  await account("ytClips", "YOUTUBE", "Pokemoha Clips", "Clips", "2026-11-13T10:00:00Z");
  await account("ytMain", "YOUTUBE", "Pokemoha", null, "2026-07-13T10:00:00Z");
  await account("ttMain", "TIKTOK", "Pokemoha", null, "2026-07-08T10:00:00Z");
  await account("ttClips", "TIKTOK", "pokemoha.clips", "Clips", "2026-11-13T10:05:00Z");
  await account("igMain", "INSTAGRAM", "moha_pokemoh", null, "2026-07-09T10:00:00Z");
  await account("igClips", "INSTAGRAM", "pokemoha_clips", "Clips", "2026-11-13T10:10:00Z");
  videoId = (
    await db.mediaAsset.create({
      data: { userId, storageKey: "media/vitest-ma/clip.mp4", mimeType: "video/mp4", sizeBytes: 1000, status: "READY", width: 1080, height: 1920, durationSec: 30 },
    })
  ).id;
});

afterAll(async () => {
  await db.user.deleteMany({ where: { email: TEST_EMAIL } });
});

describe("compte de chaque cible", () => {
  it("par défaut : les comptes principaux (les plus anciens)", async () => {
    const { postId } = await saveDraftForUser(userId, shortPost());
    expect(await targetAccount(postId!, "YOUTUBE")).toBe(ids.ytMain);
    expect(await targetAccount(postId!, "TIKTOK")).toBe(ids.ttMain);
  });

  it("par nom (connecteur) sur toutes les plateformes cochées, puis gardé à la modification suivante", async () => {
    const { postId, error } = await saveDraftForUser(userId, shortPost({ accountRef: "clips" }));
    expect(error).toBeUndefined();
    expect(await targetAccount(postId!, "YOUTUBE")).toBe(ids.ytClips);
    expect(await targetAccount(postId!, "TIKTOK")).toBe(ids.ttClips);

    // Modification sans préciser de compte (ex. composer web d'avant, ou légende corrigée par Claude).
    await saveDraftForUser(userId, shortPost({ postId, caption: "Légende corrigée" }));
    expect(await targetAccount(postId!, "YOUTUBE")).toBe(ids.ytClips);

    // null = retour au principal ; identifiant explicite (composer) par réseau.
    await saveDraftForUser(userId, shortPost({ postId, accountRef: null }));
    expect(await targetAccount(postId!, "YOUTUBE")).toBe(ids.ytMain);
    await saveDraftForUser(userId, shortPost({ postId, accountIds: { YOUTUBE: ids.ytClips } }));
    expect(await targetAccount(postId!, "YOUTUBE")).toBe(ids.ytClips);
    expect(await targetAccount(postId!, "TIKTOK")).toBe(ids.ttMain);
  });

  it("nom inconnu sur une plateforme cochée : refus, rien d'enregistré", async () => {
    const before = await db.post.count({ where: { userId } });
    const result = await saveDraftForUser(userId, shortPost({ accountRef: "gaming" }));
    expect(result.error).toMatch(/Aucun compte (YouTube|TikTok) « gaming »/);
    expect(await db.post.count({ where: { userId } })).toBe(before);
  });

  it("identifiant d'un compte d'un autre réseau : refus", async () => {
    const result = await saveDraftForUser(userId, shortPost({ accountIds: { YOUTUBE: ids.ttClips } }));
    expect(result.error).toMatch(/Compte YouTube introuvable/);
  });
});

describe("plafond TikTok compté par compte", () => {
  it("5 brouillons sur le compte principal n'empêchent pas un brouillon sur le compte clips", async () => {
    const at = new Date(Math.ceil((Date.now() + 30 * HOUR) / 60_000) * 60_000);
    const created: string[] = [];
    for (let i = 0; i < 5; i++) {
      const { postId } = await saveDraftForUser(userId, shortPost({ targetYoutube: false, caption: `Principal ${i}` }));
      created.push(postId!);
      expect(await schedulePostForUser(userId, postId!, local(new Date(at.getTime() + i * 60_000)), "Europe/Paris")).toEqual({});
    }
    const sixthMain = await saveDraftForUser(userId, shortPost({ targetYoutube: false, caption: "Principal 6" }));
    created.push(sixthMain.postId!);
    expect((await schedulePostForUser(userId, sixthMain.postId!, local(new Date(at.getTime() + 10 * 60_000)), "Europe/Paris")).error).toMatch(
      /TikTok limite à 5 brouillons/
    );
    const onClips = await saveDraftForUser(userId, shortPost({ targetYoutube: false, caption: "Clip", accountRef: "clips" }));
    created.push(onClips.postId!);
    expect(await schedulePostForUser(userId, onClips.postId!, local(new Date(at.getTime() + 10 * 60_000)), "Europe/Paris")).toEqual({});
    await db.post.deleteMany({ where: { id: { in: created } } });
  });
});

describe("statistiques Instagram du bon compte", () => {
  it("principal par défaut, autre compte par nom ou identifiant, nom inconnu = erreur", async () => {
    const byDefault = await getInstagramStatsForUser(userId);
    expect(byDefault.account?.id).toBe(ids.igMain);
    expect(byDefault.accounts.map((a) => a.name)).toEqual(["@moha_pokemoh", "Clips"]);
    expect((await getInstagramStatsForUser(userId, { accountRef: "clips" })).account?.id).toBe(ids.igClips);
    expect((await getInstagramStatsForUser(userId, { accountId: ids.igClips })).account?.id).toBe(ids.igClips);
    expect((await getInstagramStatsForUser(userId, { accountId: "inconnu" })).account?.id).toBe(ids.igMain);
    expect((await getInstagramStatsForUser(userId, { accountRef: "gaming" })).error).toMatch(/Aucun compte Instagram « gaming »/);
  });
});
