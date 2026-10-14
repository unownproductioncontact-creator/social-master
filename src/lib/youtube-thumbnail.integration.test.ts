// Test d'intégration (CLAUDE.md §37) : vraies requêtes Prisma contre la base de dev locale (§13/§16).
// YouTube, R2, Telegram, pg-boss et le jeton sont simulés : on vérifie les ÉTATS (brouillon, statut de
// la miniature, nouvel essai programmé, journal, protections contre la purge), pas le réseau.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import sharp from "sharp";

const sent: Array<{ queue: string; data: unknown; options: unknown }> = [];
const deletedKeys: string[] = [];
let tinyJpeg: Buffer;

vi.mock("@/lib/storage", () => ({
  getObjectBuffer: vi.fn(async () => tinyJpeg),
  deleteObject: vi.fn(async (key: string) => void deletedKeys.push(key)),
}));
vi.mock("@/lib/providers/youtube", () => ({
  setYouTubeThumbnail: vi.fn(),
  refreshYouTubeAccessToken: vi.fn(),
  fetchYouTubeVideoSummary: vi.fn(),
}));
vi.mock("@/lib/youtube-token", () => ({ freshYouTubeAccessToken: vi.fn(async () => "yt-token") }));
vi.mock("@/lib/telegram", () => ({ notifyTelegram: vi.fn(async () => {}) }));
vi.mock("@/worker/boss", () => ({
  PUBLISH_QUEUE: "publish",
  YOUTUBE_THUMBNAIL_QUEUE: "youtube-thumbnail",
  getBoss: () => ({
    send: vi.fn(async (queue: string, data: unknown, options: unknown) => {
      sent.push({ queue, data, options });
      return "job-id";
    }),
    cancel: vi.fn(async () => {}),
  }),
  dbFromPrismaTx: vi.fn(),
}));

const { db } = await import("@/lib/db");
const { saveDraftForUser } = await import("@/lib/post-service");
const { applyYouTubeThumbnail, requestYouTubeThumbnailForUser, scheduleThumbnailAfterUpload, checkProcessingThenApply } = await import(
  "@/lib/youtube-thumbnail-service"
);
const { runMediaCleanup } = await import("@/worker/media-cleanup-job");
const { purgeMediaForPublishedPost } = await import("@/lib/media-delete");
const { setYouTubeThumbnail, fetchYouTubeVideoSummary } = await import("@/lib/providers/youtube");
const { notifyTelegram } = await import("@/lib/telegram");

const TEST_EMAIL = "vitest-yt-thumbnail@test.local";
const DAY_MS = 24 * 60 * 60 * 1000;
const UPLOAD_SCOPES = ["https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtube.readonly"];

let userId: string;
let youtubeAccountId: string;
let videoId: string;
let thumbId: string;
let otherThumbId: string;

async function createMedia(name: string, mimeType: string, extra: { createdAt?: Date } = {}) {
  const media = await db.mediaAsset.create({
    data: { userId, storageKey: `media/vitest-yt-thumb/${name}`, mimeType, sizeBytes: 1000, status: "READY", ...extra },
  });
  return media.id;
}

/** Post publié sur YouTube (vidéo en ligne) avec la miniature demandée, prêt pour applyYouTubeThumbnail. */
async function publishedYouTubeTarget(coverId: string | null, thumbnailStatus: "PENDING" | "SET" | "FAILED" | null = "PENDING") {
  const post = await db.post.create({ data: { userId, caption: "Short publié", status: "PUBLISHED" } });
  await db.postMedia.create({ data: { postId: post.id, mediaAssetId: videoId, position: 0 } });
  const target = await db.postTarget.create({
    data: {
      postId: post.id,
      socialAccountId: youtubeAccountId,
      platform: "YOUTUBE",
      contentType: "YOUTUBE_SHORT",
      status: "PUBLISHED",
      platformPostId: "yt_video_1",
      platformPostUrl: "https://www.youtube.com/shorts/yt_video_1",
      publishedAt: new Date(),
      coverMediaAssetId: coverId,
      thumbnailStatus,
    },
  });
  return { postId: post.id, targetId: target.id };
}

function apiError(status: number, reason: string) {
  return new Error(
    `Miniature YouTube refusée (${status}): ${JSON.stringify({ error: { code: status, message: reason, errors: [{ reason }] } })}`
  );
}

// Ce fichier teste le circuit complet de la miniature, coupé par défaut pour les Shorts (§37, 14/10/2026) :
// on le rallume ici comme le ferait YOUTUBE_SHORTS_THUMBNAIL_API=1 sur Render ; le comportement coupé
// (défaut) est testé à part en fin de fichier.
const savedSwitch = process.env.YOUTUBE_SHORTS_THUMBNAIL_API;

beforeAll(async () => {
  process.env.YOUTUBE_SHORTS_THUMBNAIL_API = "1";
  tinyJpeg = await sharp({ create: { width: 108, height: 192, channels: 3, background: "#ff0055" } }).jpeg().toBuffer();
  await db.user.deleteMany({ where: { email: TEST_EMAIL } });
  const user = await db.user.create({ data: { email: TEST_EMAIL, passwordHash: "x", name: "Vitest" } });
  userId = user.id;
  youtubeAccountId = (
    await db.socialAccount.create({
      data: {
        userId,
        platform: "YOUTUBE",
        platformAccountId: `UC_vitest_${user.id}`,
        username: "Chaîne test",
        accessTokenEnc: "x",
        refreshTokenEnc: "x",
        grantedScopes: UPLOAD_SCOPES,
      },
    })
  ).id;
  // Compte Instagram : nécessaire aux brouillons Reel (couverture), retrouvé par saveDraftForUser.
  await db.socialAccount.create({
    data: { userId, platform: "INSTAGRAM", platformAccountId: `ig_vitest_${user.id}`, username: "moha_test", accessTokenEnc: "x" },
  });
  videoId = await createMedia("short.mp4", "video/mp4");
  thumbId = await createMedia("short - miniature.jpg", "image/jpeg");
  otherThumbId = await createMedia("autre miniature.png", "image/png");
});

beforeEach(() => {
  sent.length = 0;
  deletedKeys.length = 0;
  vi.mocked(setYouTubeThumbnail).mockReset();
  vi.mocked(fetchYouTubeVideoSummary).mockReset();
  vi.mocked(notifyTelegram).mockClear();
});

/** État de traitement que « voit » YouTube pour la vidéo de test. */
function videoState(uploadStatus: string) {
  vi.mocked(fetchYouTubeVideoSummary).mockResolvedValue({ uploadStatus, privacyStatus: "unlisted", thumbnails: {} });
}

afterAll(async () => {
  if (savedSwitch === undefined) delete process.env.YOUTUBE_SHORTS_THUMBNAIL_API;
  else process.env.YOUTUBE_SHORTS_THUMBNAIL_API = savedSwitch;
  await db.user.deleteMany({ where: { email: TEST_EMAIL } }); // cascade : comptes, médias, posts, cibles, journal
});

describe("save_draft : miniature YouTube, visibilité, couverture de Reel", () => {
  it("pose la miniature (PENDING) et la visibilité ; une réédition SANS ces champs les garde ; null retire", async () => {
    const created = await saveDraftForUser(userId, {
      caption: "Mon Short",
      hashtags: [],
      mediaAssetIds: [videoId],
      targetInstagram: false,
      targetInstagramStory: false,
      targetTiktok: false,
      targetYoutube: true,
      youtubeThumbnailMediaId: thumbId,
      youtubePrivacy: "unlisted",
    });
    expect(created.error).toBeUndefined();
    const postId = created.postId!;
    let target = await db.postTarget.findFirstOrThrow({ where: { postId, platform: "YOUTUBE" } });
    expect(target.coverMediaAssetId).toBe(thumbId);
    expect(target.thumbnailStatus).toBe("PENDING");
    expect(target.platformOptions).toEqual({ privacy: "unlisted" });

    // Réédition comme le ferait le composer web (qui ignore ces champs) : rien n'est perdu.
    const edited = await saveDraftForUser(userId, {
      postId,
      caption: "Mon Short corrigé",
      hashtags: [],
      mediaAssetIds: [videoId],
      targetInstagram: false,
      targetInstagramStory: false,
      targetTiktok: false,
      targetYoutube: true,
      youtubeTitle: "Titre",
    });
    expect(edited.error).toBeUndefined();
    target = await db.postTarget.findFirstOrThrow({ where: { postId, platform: "YOUTUBE" } });
    expect(target.coverMediaAssetId).toBe(thumbId);
    expect(target.thumbnailStatus).toBe("PENDING");
    expect(target.platformOptions).toEqual({ title: "Titre", privacy: "unlisted" });

    // null = retirer la miniature ; public = plus de clé privacy.
    await saveDraftForUser(userId, {
      postId,
      caption: "Mon Short corrigé",
      hashtags: [],
      mediaAssetIds: [videoId],
      targetInstagram: false,
      targetInstagramStory: false,
      targetTiktok: false,
      targetYoutube: true,
      youtubeThumbnailMediaId: null,
      youtubePrivacy: "public",
    });
    target = await db.postTarget.findFirstOrThrow({ where: { postId, platform: "YOUTUBE" } });
    expect(target.coverMediaAssetId).toBeNull();
    expect(target.thumbnailStatus).toBeNull();
    expect(target.platformOptions).toEqual({});
  });

  it("couverture de Reel : stockée sur la cible Instagram ; refusée hors Reel", async () => {
    const reel = await saveDraftForUser(userId, {
      caption: "Reel",
      hashtags: [],
      mediaAssetIds: [videoId],
      targetInstagram: true,
      targetInstagramStory: false,
      targetTiktok: false,
      targetYoutube: false,
      instagramCoverMediaId: thumbId,
      instagramCoverTimeMs: 900,
    });
    expect(reel.error).toBeUndefined();
    const target = await db.postTarget.findFirstOrThrow({ where: { postId: reel.postId!, platform: "INSTAGRAM" } });
    expect(target.coverMediaAssetId).toBe(thumbId);
    expect(target.platformOptions).toEqual({ coverTimeMs: 900 });
    expect(target.thumbnailStatus).toBeNull(); // statut de miniature : YouTube seulement

    const image = await saveDraftForUser(userId, {
      caption: "Image",
      hashtags: [],
      mediaAssetIds: [thumbId],
      targetInstagram: true,
      targetInstagramStory: false,
      targetTiktok: false,
      targetYoutube: false,
      instagramCoverMediaId: otherThumbId,
    });
    expect(image.error).toMatch(/Reel/);
  });

  it("refus explicites : vidéo comme miniature, miniature sans YouTube, image d'un autre compte", async () => {
    const base = {
      caption: "x",
      hashtags: [],
      mediaAssetIds: [videoId],
      targetInstagram: false,
      targetInstagramStory: false,
      targetTiktok: false,
      targetYoutube: true,
    };
    expect((await saveDraftForUser(userId, { ...base, youtubeThumbnailMediaId: videoId })).error).toMatch(/image/);
    expect((await saveDraftForUser(userId, { ...base, targetYoutube: false, targetInstagram: true, youtubeThumbnailMediaId: thumbId })).error).toMatch(
      /cocher YouTube/
    );
    expect((await saveDraftForUser(userId, { ...base, youtubeThumbnailMediaId: "inexistant" })).error).toMatch(/introuvable/);
  });
});

describe("applyYouTubeThumbnail : statut séparé, nouvel essai, journal", () => {
  it("succès : SET, date, journal avec les URLs ; l'image part telle quelle (JPEG léger)", async () => {
    vi.mocked(setYouTubeThumbnail).mockResolvedValueOnce({ maxres: "https://i.ytimg.com/vi/yt_video_1/maxresdefault.jpg" });
    const { targetId } = await publishedYouTubeTarget(thumbId);

    const outcome = await applyYouTubeThumbnail(targetId, { attempt: 1, justUploaded: true });
    expect(outcome).toMatchObject({ status: "SET", recompressed: false });

    const call = vi.mocked(setYouTubeThumbnail).mock.calls[0];
    expect(call[0]).toBe("yt-token");
    expect(call[1]).toBe("yt_video_1");
    expect(call[2].contentType).toBe("image/jpeg");
    expect(call[2].data).toBe(tinyJpeg);

    const target = await db.postTarget.findUniqueOrThrow({ where: { id: targetId } });
    expect(target.thumbnailStatus).toBe("SET");
    expect(target.thumbnailError).toBeNull();
    expect(target.thumbnailSetAt).toBeInstanceOf(Date);
    const log = await db.activityLog.findFirstOrThrow({ where: { entityId: targetId, action: "youtube_thumbnail_set" } });
    expect(log.detail).toMatchObject({ videoId: "yt_video_1", mediaId: thumbId, urls: { maxres: expect.any(String) } });
  });

  it("erreur 503 au 1er essai : PENDING + UN nouvel essai programmé dans 5 min ; 503 encore → FAILED + Telegram", async () => {
    const { targetId } = await publishedYouTubeTarget(thumbId);
    vi.mocked(setYouTubeThumbnail).mockRejectedValueOnce(apiError(503, "backendError"));

    const first = await applyYouTubeThumbnail(targetId, { attempt: 1, justUploaded: true });
    expect(first.status).toBe("PENDING");
    expect(sent).toHaveLength(1);
    expect(sent[0].queue).toBe("youtube-thumbnail");
    expect(sent[0].data).toEqual({ postTargetId: targetId, mediaAssetId: thumbId });
    const startAfter = (sent[0].options as { startAfter: Date }).startAfter.getTime();
    expect(startAfter - Date.now()).toBeGreaterThan(4 * 60 * 1000);
    let target = await db.postTarget.findUniqueOrThrow({ where: { id: targetId } });
    expect(target.thumbnailStatus).toBe("PENDING");
    expect(target.thumbnailError).toMatch(/Nouvel essai automatique vers \d\d:\d\d/);
    expect(notifyTelegram).not.toHaveBeenCalled();

    vi.mocked(setYouTubeThumbnail).mockRejectedValueOnce(apiError(503, "backendError"));
    const second = await applyYouTubeThumbnail(targetId, { attempt: 2, expectedMediaId: thumbId });
    expect(second.status).toBe("FAILED");
    expect(sent).toHaveLength(1); // pas de troisième essai
    target = await db.postTarget.findUniqueOrThrow({ where: { id: targetId } });
    expect(target.thumbnailStatus).toBe("FAILED");
    expect(target.thumbnailError).toMatch(/échec aussi au nouvel essai/);
    expect(notifyTelegram).toHaveBeenCalledTimes(1);
    const failedLog = await db.activityLog.findFirstOrThrow({ where: { entityId: targetId, action: "youtube_thumbnail_failed" } });
    expect(failedLog.detail).toMatchObject({ code: "yt_thumb_server_error", rawError: expect.stringContaining("503") });
  });

  it("403 : FAILED tout de suite, message chaîne non éligible / non vérifiée, aucun nouvel essai", async () => {
    const { targetId } = await publishedYouTubeTarget(thumbId);
    vi.mocked(setYouTubeThumbnail).mockRejectedValueOnce(apiError(403, "forbidden"));
    const outcome = await applyYouTubeThumbnail(targetId, { attempt: 1, justUploaded: true });
    expect(outcome).toMatchObject({ status: "FAILED", code: "yt_thumb_forbidden" });
    expect(sent).toHaveLength(0);
    const target = await db.postTarget.findUniqueOrThrow({ where: { id: targetId } });
    expect(target.thumbnailError).toMatch(/non éligible/);
    expect(target.status).toBe("PUBLISHED"); // la vidéo n'est jamais touchée
  });

  it("jeton sans scope d'envoi : FAILED sans appeler YouTube", async () => {
    await db.socialAccount.update({ where: { id: youtubeAccountId }, data: { grantedScopes: ["https://www.googleapis.com/auth/youtube.readonly"] } });
    try {
      const { targetId } = await publishedYouTubeTarget(thumbId);
      const outcome = await applyYouTubeThumbnail(targetId, { attempt: 1 });
      expect(outcome).toMatchObject({ status: "FAILED", code: "yt_thumb_scope" });
      expect(setYouTubeThumbnail).not.toHaveBeenCalled();
    } finally {
      await db.socialAccount.update({ where: { id: youtubeAccountId }, data: { grantedScopes: UPLOAD_SCOPES } });
    }
  });

  it("nouvel essai devenu sans objet (image remplacée) : rien n'est fait", async () => {
    const { targetId } = await publishedYouTubeTarget(otherThumbId);
    const outcome = await applyYouTubeThumbnail(targetId, { attempt: 2, expectedMediaId: thumbId });
    expect(outcome.status).toBe("SKIPPED");
    expect(setYouTubeThumbnail).not.toHaveBeenCalled();
  });

  it("image supprimée de la médiathèque avant la publication : FAILED avec la raison", async () => {
    const doomed = await createMedia("supprimée.jpg", "image/jpeg");
    const { targetId } = await publishedYouTubeTarget(doomed);
    await db.mediaAsset.delete({ where: { id: doomed } }); // relation → null (SetNull)
    const outcome = await applyYouTubeThumbnail(targetId, { attempt: 1, justUploaded: true });
    expect(outcome).toMatchObject({ status: "FAILED", code: "yt_thumb_media_deleted" });
  });
});

describe("attente de la fin du traitement YouTube (constat du test réel du 13/10/2026)", () => {
  it("après la publication : rien n'est envoyé tout de suite, 1re vérification programmée ~45 s plus tard", async () => {
    const { targetId } = await publishedYouTubeTarget(thumbId);
    const outcome = await scheduleThumbnailAfterUpload(targetId);
    expect(outcome.status).toBe("PENDING");
    expect(setYouTubeThumbnail).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
    expect(sent[0].data).toEqual({ postTargetId: targetId, mediaAssetId: thumbId, kind: "processing", check: 1 });
    const delay = (sent[0].options as { startAfter: Date }).startAfter.getTime() - Date.now();
    expect(delay).toBeGreaterThan(40_000);
    expect(delay).toBeLessThan(60_000);
  });

  it("encore « uploaded » : nouvelle vérification dans 2 min, sans appeler thumbnails.set", async () => {
    const { targetId } = await publishedYouTubeTarget(thumbId);
    videoState("uploaded");
    const outcome = await checkProcessingThenApply(targetId, thumbId, 3);
    expect(outcome.status).toBe("PENDING");
    expect(setYouTubeThumbnail).not.toHaveBeenCalled();
    expect(sent[0].data).toEqual({ postTargetId: targetId, mediaAssetId: thumbId, kind: "processing", check: 4 });
    const delay = (sent[0].options as { startAfter: Date }).startAfter.getTime() - Date.now();
    expect(delay).toBeGreaterThan(100_000);
  });

  it("« processed » : la miniature part → SET", async () => {
    const { targetId } = await publishedYouTubeTarget(thumbId);
    videoState("processed");
    vi.mocked(setYouTubeThumbnail).mockResolvedValueOnce({ high: "https://i.ytimg.com/vi/yt_video_1/hqdefault.jpg" });
    expect((await checkProcessingThenApply(targetId, thumbId, 2)).status).toBe("SET");
    expect(sent).toHaveLength(0);
  });

  it("traitement échoué chez YouTube : FAILED expliqué, aucun envoi", async () => {
    const { targetId } = await publishedYouTubeTarget(thumbId);
    videoState("failed");
    expect(await checkProcessingThenApply(targetId, thumbId, 2)).toMatchObject({ status: "FAILED", code: "yt_thumb_video_failed" });
    expect(setYouTubeThumbnail).not.toHaveBeenCalled();
  });

  it("~40 min sans fin de traitement : un dernier essai, et un 403 est expliqué par ce délai", async () => {
    const { targetId } = await publishedYouTubeTarget(thumbId);
    videoState("uploaded");
    vi.mocked(setYouTubeThumbnail).mockRejectedValueOnce(
      new Error(
        `Miniature YouTube refusée (403): ${JSON.stringify({
          error: { code: 403, message: "The thumbnail can't be set for the specified video. The request might not be properly authorized.", errors: [{ reason: "forbidden" }] },
        })}`
      )
    );
    const outcome = await checkProcessingThenApply(targetId, thumbId, 20);
    expect(outcome).toMatchObject({ status: "FAILED", code: "yt_thumb_forbidden_video" });
    expect((await db.postTarget.findUniqueOrThrow({ where: { id: targetId } })).thumbnailError).toMatch(/toujours en traitement/);
  });

  it("lecture de l'état impossible : traitée comme « pas encore prêt »", async () => {
    const { targetId } = await publishedYouTubeTarget(thumbId);
    vi.mocked(fetchYouTubeVideoSummary).mockRejectedValueOnce(new TypeError("fetch failed"));
    expect((await checkProcessingThenApply(targetId, thumbId, 1)).status).toBe("PENDING");
    expect(sent[0].data).toMatchObject({ kind: "processing", check: 2 });
  });

  it("image remplacée pendant l'attente : la vérification s'arrête", async () => {
    const { targetId } = await publishedYouTubeTarget(otherThumbId);
    videoState("processed");
    expect((await checkProcessingThenApply(targetId, thumbId, 2)).status).toBe("SKIPPED");
    expect(setYouTubeThumbnail).not.toHaveBeenCalled();
  });
});

describe("set_youtube_thumbnail", () => {
  it("vidéo encore en traitement : PENDING, vérification programmée ~45 s plus tard", async () => {
    const { postId, targetId } = await publishedYouTubeTarget(null, null);
    videoState("uploaded");
    const result = await requestYouTubeThumbnailForUser(userId, postId, thumbId);
    expect(result.outcome?.status).toBe("PENDING");
    expect(setYouTubeThumbnail).not.toHaveBeenCalled();
    expect(sent[0].data).toEqual({ postTargetId: targetId, mediaAssetId: thumbId, kind: "processing", check: 2 });
  });

  it("vidéo déjà publiée : envoi immédiat → SET ; vidéo pas encore publiée : retenue sans appel", async () => {
    videoState("processed");
    vi.mocked(setYouTubeThumbnail).mockResolvedValueOnce({ high: "https://i.ytimg.com/vi/yt_video_1/hqdefault.jpg" });
    const { postId, targetId } = await publishedYouTubeTarget(null, null);
    const published = await requestYouTubeThumbnailForUser(userId, postId, otherThumbId);
    expect(published.outcome?.status).toBe("SET");
    // Le PNG léger part tel quel (PNG accepté par YouTube).
    expect(vi.mocked(setYouTubeThumbnail).mock.calls[0][2].contentType).toBe("image/png");
    expect((await db.postTarget.findUniqueOrThrow({ where: { id: targetId } })).coverMediaAssetId).toBe(otherThumbId);

    const draft = await saveDraftForUser(userId, {
      caption: "Pas encore publié",
      hashtags: [],
      mediaAssetIds: [videoId],
      targetInstagram: false,
      targetInstagramStory: false,
      targetTiktok: false,
      targetYoutube: true,
    });
    const pending = await requestYouTubeThumbnailForUser(userId, draft.postId!, thumbId);
    expect(pending.outcome?.status).toBe("PENDING");
    expect(setYouTubeThumbnail).toHaveBeenCalledTimes(1);

    expect((await requestYouTubeThumbnailForUser(userId, draft.postId!, videoId)).error).toMatch(/image/);
    expect((await requestYouTubeThumbnailForUser("autre-user", draft.postId!, thumbId)).error).toMatch(/introuvable/);
  });
});

describe("ménage des médias : une image de miniature n'est jamais prise pour un média inutilisé", () => {
  it("vieille de 40 jours mais miniature d'une cible : conservée par la passe « jamais utilisé »", async () => {
    const oldThumb = await createMedia("vieille miniature.jpg", "image/jpeg", { createdAt: new Date(Date.now() - 40 * DAY_MS) });
    const oldUnused = await createMedia("vieille inutile.jpg", "image/jpeg", { createdAt: new Date(Date.now() - 40 * DAY_MS) });
    await publishedYouTubeTarget(oldThumb, "SET");

    await runMediaCleanup();
    expect(await db.mediaAsset.findUnique({ where: { id: oldThumb } })).not.toBeNull();
    expect(await db.mediaAsset.findUnique({ where: { id: oldUnused } })).toBeNull();
  });

  it("rétention « Dès la publication » : image posée (SET) purgée avec la vidéo ; en échec (FAILED), gardée pour reposer", async () => {
    await db.user.update({ where: { id: userId }, data: { mediaRetentionDays: 0 } });
    try {
      const setThumb = await createMedia("posée.jpg", "image/jpeg");
      const setPost = await publishedYouTubeTarget(setThumb, "SET");
      await purgeMediaForPublishedPost(setPost.postId);
      expect(await db.mediaAsset.findUnique({ where: { id: setThumb } })).toBeNull();

      // Vidéo propre à ce post (la première sert aussi aux brouillons ci-dessus, donc jamais purgée).
      videoId = await createMedia("short-2.mp4", "video/mp4");
      const failedThumb = await createMedia("refusée.jpg", "image/jpeg");
      const failedPost = await publishedYouTubeTarget(failedThumb, "FAILED");
      await purgeMediaForPublishedPost(failedPost.postId);
      expect(await db.mediaAsset.findUnique({ where: { id: failedThumb } })).not.toBeNull();
      expect(await db.mediaAsset.findUnique({ where: { id: videoId } })).toBeNull(); // la vidéo, elle, part
    } finally {
      await db.user.update({ where: { id: userId }, data: { mediaRetentionDays: null } });
    }
  });
});

describe("coupée par défaut pour les Shorts (variable absente, décision du 14/10/2026)", () => {
  it("brouillon refusé, set_youtube_thumbnail refusé, demande en attente close sans aucun appel à YouTube", async () => {
    delete process.env.YOUTUBE_SHORTS_THUMBNAIL_API;
    try {
      // Vidéo propre à ce test : celles du dessus peuvent avoir été purgées par les tests de rétention.
      videoId = await createMedia("short-coupé.mp4", "video/mp4");
      const draft = await saveDraftForUser(userId, {
        caption: "Short",
        hashtags: [],
        mediaAssetIds: [videoId],
        targetInstagram: false,
        targetInstagramStory: false,
        targetTiktok: false,
        targetYoutube: true,
        youtubeThumbnailMediaId: thumbId,
      });
      expect(draft.error).toMatch(/Miniature de Short désactivée/);

      const { postId, targetId } = await publishedYouTubeTarget(thumbId, "PENDING");
      expect((await requestYouTubeThumbnailForUser(userId, postId, thumbId)).error).toMatch(/Miniature de Short désactivée/);

      expect((await scheduleThumbnailAfterUpload(targetId)).status).toBe("SKIPPED");
      expect((await applyYouTubeThumbnail(targetId, { attempt: 1 })).status).toBe("SKIPPED");
      expect(setYouTubeThumbnail).not.toHaveBeenCalled();
      expect(sent).toHaveLength(0);
      const target = await db.postTarget.findUniqueOrThrow({ where: { id: targetId } });
      expect(target.thumbnailStatus).toBe("FAILED");
      expect(target.thumbnailError).toMatch(/YouTube Studio sur ordinateur/);
    } finally {
      process.env.YOUTUBE_SHORTS_THUMBNAIL_API = "1";
    }
  });
});
