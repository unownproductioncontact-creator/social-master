// Test d'intégration de la Page Facebook (CLAUDE.md §40) : vraies requêtes Prisma contre la base de dev
// locale ; l'API Facebook, R2, pg-boss, Telegram et le chiffrement des jetons sont simulés. On vérifie
// les ÉTATS : type de publication choisi au brouillon, cible PUBLISHED avec son lien, reprise d'une vidéo
// déjà publiée SANS republication, jeton invalide → compte en pause, et un compte Facebook jamais traité
// comme un compte TikTok (rafraîchissement quotidien, « Vérifier »).
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { JobWithMetadata } from "pg-boss";

const boss = { send: vi.fn(async () => "job-id"), cancel: vi.fn(async () => {}) };
vi.mock("@/worker/boss", () => ({
  PUBLISH_QUEUE: "publish",
  YOUTUBE_THUMBNAIL_QUEUE: "youtube-thumbnail",
  YOUTUBE_PUBLICATION_QUEUE: "youtube-publication",
  MEDIA_IMPORT_QUEUE: "media-import",
  getBoss: () => boss,
  dbFromPrismaTx: vi.fn(),
}));
vi.mock("@/lib/crypto", () => ({ decryptToken: (v: string) => v, encryptToken: (v: string) => v }));
vi.mock("@/lib/storage", () => ({
  getPublicMediaUrl: (key: string) => `https://worker.test/m/${key}`,
  mediaWorkerEnabled: () => true,
  mediaWorkerPushConfig: () => ({ url: "https://worker.test", secret: "s" }),
  getObjectBuffer: vi.fn(),
  putObjectBuffer: vi.fn(),
  objectExists: vi.fn(async () => true),
  deleteObject: vi.fn(async () => {}),
}));
vi.mock("@/lib/image-convert", () => ({ ensureJpegVersion: vi.fn(async (key: string) => key) }));
vi.mock("@/lib/telegram", () => ({ notifyTelegram: vi.fn(async () => {}) }));
vi.mock("@/lib/tiktok-token", () => ({ freshTikTokAccessToken: vi.fn(async () => "tt-token") }));
vi.mock("@/lib/providers/facebook", () => ({
  startFacebookReel: vi.fn(),
  uploadFacebookReelFromUrl: vi.fn(),
  finishFacebookReel: vi.fn(),
  facebookReelPublishRequested: vi.fn(),
  waitForFacebookVideo: vi.fn(),
  publishFacebookVideoFromUrl: vi.fn(),
  publishFacebookPhoto: vi.fn(),
  publishFacebookPhotos: vi.fn(),
  fetchFacebookPermalink: vi.fn(),
  fetchFacebookPage: vi.fn(),
}));

const { db } = await import("@/lib/db");
const { saveDraftForUser } = await import("@/lib/post-service");
const { handlePublishBatch } = await import("@/worker/publish-job");
const { runTokenRefresh } = await import("@/worker/token-refresh-job");
const { checkSocialAccountHealth } = await import("@/lib/social-account-health");
const { freshTikTokAccessToken } = await import("@/lib/tiktok-token");
const { FacebookStillProcessingError } = await import("@/lib/errors");
const fb = await import("@/lib/providers/facebook");

const TEST_EMAIL = "vitest-facebook@test.local";

let userId: string;
let accountId: string;
let verticalVideo: string;
let horizontalVideo: string;
let photoA: string;
let photoB: string;

async function media(storageKey: string, mimeType: string, dims: { width?: number; height?: number; durationSec?: number } = {}) {
  return (
    await db.mediaAsset.create({
      data: { userId, storageKey, mimeType, sizeBytes: 1000, status: "READY", ...dims },
    })
  ).id;
}

/** Post programmé avec une cible Facebook prête à partir (+ son PublishJob). */
async function seedTarget(contentType: "FACEBOOK_REEL" | "FACEBOOK_VIDEO" | "FACEBOOK_PHOTO" | "FACEBOOK_PHOTOS", mediaIds: string[]) {
  const post = await db.post.create({ data: { userId, caption: "Ils ont tout raflé", hashtags: ["pokemon"], status: "SCHEDULED" } });
  await db.postMedia.createMany({ data: mediaIds.map((mediaAssetId, position) => ({ postId: post.id, mediaAssetId, position })) });
  const target = await db.postTarget.create({
    data: { postId: post.id, socialAccountId: accountId, platform: "FACEBOOK", contentType, status: "PENDING" },
  });
  const job = await db.publishJob.create({
    data: { postTargetId: target.id, runAt: new Date(), idempotencyKey: `vitest-fb-${target.id}`, state: "WAITING" },
  });
  return { postId: post.id, targetId: target.id, key: job.idempotencyKey };
}

function job(postTargetId: string, idempotencyKey: string, retryCount = 0) {
  return [{ id: "job-1", data: { postTargetId, idempotencyKey }, retryCount, retryLimit: 3 }] as unknown as JobWithMetadata<{
    postTargetId: string;
    idempotencyKey: string;
  }>[];
}

beforeAll(async () => {
  await db.user.deleteMany({ where: { email: TEST_EMAIL } });
  userId = (await db.user.create({ data: { email: TEST_EMAIL, passwordHash: "x", name: "Vitest" } })).id;
  accountId = (
    await db.socialAccount.create({
      data: {
        userId,
        platform: "FACEBOOK",
        platformAccountId: `page_${userId}`,
        username: "Pokemoha",
        accessTokenEnc: "page_tok",
        grantedScopes: ["pages_show_list", "pages_read_engagement", "pages_manage_posts"],
      },
    })
  ).id;
  verticalVideo = await media("media/vitest-fb/short.mp4", "video/mp4", { width: 1080, height: 1920, durationSec: 47 });
  horizontalVideo = await media("media/vitest-fb/long.mp4", "video/mp4", { width: 1920, height: 1080, durationSec: 600 });
  photoA = await media("media/vitest-fb/a.png", "image/png");
  photoB = await media("media/vitest-fb/b.jpg", "image/jpeg");
});

beforeEach(() => {
  for (const fn of Object.values(fb)) if (vi.isMockFunction(fn)) fn.mockReset();
  vi.mocked(fb.fetchFacebookPermalink).mockResolvedValue(null);
});

afterAll(async () => {
  await db.user.deleteMany({ where: { email: TEST_EMAIL } });
});

describe("brouillon : le type Facebook suit les médias", () => {
  const save = (mediaAssetIds: string[]) =>
    saveDraftForUser(userId, { caption: "x", hashtags: [], mediaAssetIds, targetInstagram: false, targetInstagramStory: false, targetTiktok: false, targetYoutube: false, targetFacebook: true });
  const typeOf = async (postId: string) => (await db.postTarget.findFirstOrThrow({ where: { postId, platform: "FACEBOOK" } })).contentType;

  it("vidéo verticale de 47 s → Reel ; vidéo horizontale de 10 min → vidéo ; photo(s) → photo / plusieurs photos", async () => {
    expect(await typeOf((await save([verticalVideo])).postId!)).toBe("FACEBOOK_REEL");
    expect(await typeOf((await save([horizontalVideo])).postId!)).toBe("FACEBOOK_VIDEO");
    expect(await typeOf((await save([photoA])).postId!)).toBe("FACEBOOK_PHOTO");
    expect(await typeOf((await save([photoA, photoB])).postId!)).toBe("FACEBOOK_PHOTOS");
  });

  it("vidéo mêlée à une photo → refus clair ; sans Page connectée → refus clair", async () => {
    expect((await save([verticalVideo, photoA])).error).toMatch(/Facebook : une vidéo seule/);
    const other = await db.user.create({ data: { email: `nofb-${TEST_EMAIL}`, passwordHash: "x" } });
    try {
      const own = (await db.mediaAsset.create({ data: { userId: other.id, storageKey: "media/x/y.jpg", mimeType: "image/jpeg", sizeBytes: 1, status: "READY" } })).id;
      const result = await saveDraftForUser(other.id, {
        caption: "x",
        hashtags: [],
        mediaAssetIds: [own],
        targetInstagram: false,
        targetInstagramStory: false,
        targetTiktok: false,
        targetYoutube: false,
        targetFacebook: true,
      });
      expect(result.error).toMatch(/Connectez d'abord votre Page Facebook/);
    } finally {
      await db.user.delete({ where: { id: other.id } });
    }
  });
});

describe("publication sur la Page", () => {
  it("Reel : réservé, envoyé par l'URL du Worker, publié avec légende + hashtags ; cible PUBLISHED avec son lien", async () => {
    const { postId, targetId, key } = await seedTarget("FACEBOOK_REEL", [verticalVideo]);
    vi.mocked(fb.startFacebookReel).mockResolvedValue("vid_1");
    vi.mocked(fb.fetchFacebookPermalink).mockResolvedValue("https://www.facebook.com/reel/vid_1/");

    expect(await handlePublishBatch(job(targetId, key))).toEqual([{ id: "job-1", status: "completed" }]);
    expect(fb.startFacebookReel).toHaveBeenCalledWith(`page_${userId}`, "page_tok");
    expect(fb.uploadFacebookReelFromUrl).toHaveBeenCalledWith("vid_1", "page_tok", "https://worker.test/m/media/vitest-fb/short.mp4");
    expect(fb.finishFacebookReel).toHaveBeenCalledWith(`page_${userId}`, "page_tok", "vid_1", "Ils ont tout raflé\n\n#pokemon");
    const target = await db.postTarget.findUniqueOrThrow({ where: { id: targetId } });
    expect(target).toMatchObject({ status: "PUBLISHED", platformPostId: "vid_1", platformPostUrl: "https://www.facebook.com/reel/vid_1/" });
    expect(await db.activityLog.count({ where: { entityId: targetId, action: "facebook_published" } })).toBe(1);
    expect((await db.post.findUniqueOrThrow({ where: { id: postId } })).status).toBe("PUBLISHED");
  });

  it("Reel encore en traitement : nouvel essai SANS republication (reprend l'attente de la même vidéo)", async () => {
    const { targetId, key } = await seedTarget("FACEBOOK_REEL", [verticalVideo]);
    vi.mocked(fb.startFacebookReel).mockResolvedValue("vid_2");
    vi.mocked(fb.waitForFacebookVideo).mockRejectedValueOnce(new FacebookStillProcessingError("vid_2"));

    expect(await handlePublishBatch(job(targetId, key, 0))).toEqual([{ id: "job-1", status: "failed" }]);
    const pending = await db.postTarget.findUniqueOrThrow({ where: { id: targetId } });
    expect(pending.status).toBe("PROCESSING");
    expect(pending.errorCode).toBe("fb_processing");
    expect(pending.platformOptions).toEqual({ fbVideo: { videoId: "vid_2", phase: "finished" } });

    expect(await handlePublishBatch(job(targetId, key, 1))).toEqual([{ id: "job-1", status: "completed" }]);
    expect(fb.startFacebookReel).toHaveBeenCalledTimes(1);
    expect(fb.finishFacebookReel).toHaveBeenCalledTimes(1);
    expect(fb.waitForFacebookVideo).toHaveBeenCalledTimes(2);
    const done = await db.postTarget.findUniqueOrThrow({ where: { id: targetId } });
    expect(done).toMatchObject({ status: "PUBLISHED", platformPostId: "vid_2", platformPostUrl: "https://www.facebook.com/reel/vid_2" });
  });

  it("vidéo classique : envoi par URL publié en un appel, puis attente", async () => {
    const { targetId, key } = await seedTarget("FACEBOOK_VIDEO", [horizontalVideo]);
    vi.mocked(fb.publishFacebookVideoFromUrl).mockResolvedValue("vid_3");
    await handlePublishBatch(job(targetId, key));
    expect(fb.publishFacebookVideoFromUrl).toHaveBeenCalledWith(`page_${userId}`, "page_tok", "https://worker.test/m/media/vitest-fb/long.mp4", "Ils ont tout raflé\n\n#pokemon");
    expect(fb.startFacebookReel).not.toHaveBeenCalled();
    expect(fb.waitForFacebookVideo).toHaveBeenCalledWith("vid_3", "page_tok", "video");
    expect((await db.postTarget.findUniqueOrThrow({ where: { id: targetId } })).status).toBe("PUBLISHED");
  });

  it("photo seule et plusieurs photos (copies JPEG servies par le Worker)", async () => {
    const one = await seedTarget("FACEBOOK_PHOTO", [photoA]);
    vi.mocked(fb.publishFacebookPhoto).mockResolvedValue({ photoId: "ph_1", postId: `page_${userId}_9` });
    await handlePublishBatch(job(one.targetId, one.key));
    expect(fb.publishFacebookPhoto).toHaveBeenCalledWith(`page_${userId}`, "page_tok", "https://worker.test/m/media/vitest-fb/a.png", "Ils ont tout raflé\n\n#pokemon");
    expect(await db.postTarget.findUniqueOrThrow({ where: { id: one.targetId } })).toMatchObject({
      status: "PUBLISHED",
      platformPostId: `page_${userId}_9`,
      platformPostUrl: `https://www.facebook.com/page_${userId}_9`,
    });

    const many = await seedTarget("FACEBOOK_PHOTOS", [photoA, photoB]);
    vi.mocked(fb.publishFacebookPhotos).mockResolvedValue(`page_${userId}_10`);
    await handlePublishBatch(job(many.targetId, many.key));
    expect(vi.mocked(fb.publishFacebookPhotos).mock.calls[0][2]).toEqual([
      "https://worker.test/m/media/vitest-fb/a.png",
      "https://worker.test/m/media/vitest-fb/b.jpg",
    ]);
    expect((await db.postTarget.findUniqueOrThrow({ where: { id: many.targetId } })).status).toBe("PUBLISHED");
  });

  it("jeton refusé (190) → échec définitif, Page en « reconnexion requise »", async () => {
    const { targetId, key } = await seedTarget("FACEBOOK_PHOTO", [photoB]);
    vi.mocked(fb.publishFacebookPhoto).mockRejectedValue(
      new Error('Facebook page/photos a échoué (400): {"error":{"message":"Session expired","type":"OAuthException","code":190}}')
    );
    expect(await handlePublishBatch(job(targetId, key))).toEqual([{ id: "job-1", status: "deadletter" }]);
    expect(await db.postTarget.findUniqueOrThrow({ where: { id: targetId } })).toMatchObject({ status: "FAILED", errorCode: "fb_token_invalid" });
    expect((await db.socialAccount.findUniqueOrThrow({ where: { id: accountId } })).status).toBe("NEEDS_REAUTH");
    await db.socialAccount.update({ where: { id: accountId }, data: { status: "ACTIVE" } });
  });
});

describe("un compte Facebook n'est jamais traité comme TikTok", () => {
  it("rafraîchissement quotidien : rien à faire, le compte reste actif", async () => {
    vi.mocked(freshTikTokAccessToken).mockClear();
    await runTokenRefresh();
    expect(freshTikTokAccessToken).not.toHaveBeenCalledWith(expect.objectContaining({ id: accountId }), expect.anything());
    expect((await db.socialAccount.findUniqueOrThrow({ where: { id: accountId } })).status).toBe("ACTIVE");
  });

  it("« Vérifier » : lecture de la Page avec son jeton ; refus → reconnexion requise", async () => {
    vi.mocked(fb.fetchFacebookPage).mockResolvedValueOnce({ id: `page_${userId}`, name: "Pokemoha" });
    await checkSocialAccountHealth(accountId);
    expect(fb.fetchFacebookPage).toHaveBeenCalledWith(`page_${userId}`, "page_tok");
    expect((await db.socialAccount.findUniqueOrThrow({ where: { id: accountId } })).status).toBe("ACTIVE");

    vi.mocked(fb.fetchFacebookPage).mockRejectedValueOnce(new Error("Facebook page a échoué (400): {}"));
    await checkSocialAccountHealth(accountId);
    expect((await db.socialAccount.findUniqueOrThrow({ where: { id: accountId } })).status).toBe("NEEDS_REAUTH");
    await db.socialAccount.update({ where: { id: accountId }, data: { status: "ACTIVE" } });
  });
});
