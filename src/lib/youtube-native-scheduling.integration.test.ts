// Test d'intégration de la programmation native YouTube (CLAUDE.md §38) : vraies requêtes Prisma contre
// la base de dev locale ; YouTube, R2, pg-boss, Telegram et le chiffrement des jetons sont simulés. On
// vérifie les ÉTATS : quand part le job, ce qui est envoyé à YouTube, PLATFORM_SCHEDULED → PUBLISHED,
// l'annulation chez YouTube (et son refus si YouTube est injoignable), l'absence de double envoi.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { JobWithMetadata } from "pg-boss";

const sent: Array<{ queue: string; data: Record<string, unknown>; options: Record<string, unknown> }> = [];
const boss = {
  send: vi.fn(async (queue: string, data: Record<string, unknown>, options: Record<string, unknown> = {}) => {
    sent.push({ queue, data, options });
    return "job-id";
  }),
  cancel: vi.fn(async () => {}),
};

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
vi.mock("@/lib/providers/youtube", () => ({
  publishYouTubeShort: vi.fn(),
  refreshYouTubeAccessToken: vi.fn(async () => ({ access_token: "fresh", expires_in: 3600, scope: "", token_type: "Bearer" })),
  fetchYouTubeVideoSummary: vi.fn(),
  deleteYouTubeVideo: vi.fn(),
  unscheduleYouTubeVideo: vi.fn(),
  setYouTubeThumbnail: vi.fn(),
}));
vi.mock("@/lib/youtube-token", () => ({ freshYouTubeAccessToken: vi.fn(async () => "yt-token") }));
vi.mock("@/lib/telegram", () => ({ notifyTelegram: vi.fn(async () => {}) }));

const { db } = await import("@/lib/db");
const { schedulePost, reschedulePost } = await import("@/lib/scheduler");
const { unschedulePostForUser } = await import("@/lib/post-service");
const { handlePublishBatch } = await import("@/worker/publish-job");
const { runYouTubePublicationCheck } = await import("@/worker/youtube-publication-job");
const { publishYouTubeShort, fetchYouTubeVideoSummary, deleteYouTubeVideo, unscheduleYouTubeVideo } = await import(
  "@/lib/providers/youtube"
);

const TEST_EMAIL = "vitest-yt-native@test.local";
const MINUTE = 60_000;

let userId: string;
let youtubeAccountId: string;
let instagramAccountId: string;
let videoId: string;
let thumbId: string;

type TargetSeed = {
  status?: "PENDING" | "PLATFORM_SCHEDULED";
  scheduledAt: Date;
  platformPostId?: string;
  options?: Record<string, string>;
  withInstagram?: boolean;
  postStatus?: "DRAFT" | "SCHEDULED";
};

/** Post avec une cible YouTube (et éventuellement Instagram) + un PublishJob, comme après une programmation. */
async function seedPost(seed: TargetSeed) {
  const post = await db.post.create({
    data: { userId, caption: "Short programmé", status: seed.postStatus ?? "SCHEDULED", scheduledAt: seed.scheduledAt },
  });
  await db.postMedia.create({ data: { postId: post.id, mediaAssetId: videoId, position: 0 } });
  const youtube = await db.postTarget.create({
    data: {
      postId: post.id,
      socialAccountId: youtubeAccountId,
      platform: "YOUTUBE",
      contentType: "YOUTUBE_SHORT",
      status: seed.status ?? "PENDING",
      scheduledAt: seed.scheduledAt,
      platformOptions: seed.options ?? {},
      platformPostId: seed.platformPostId ?? null,
      platformPostUrl: seed.platformPostId ? `https://www.youtube.com/shorts/${seed.platformPostId}` : null,
      coverMediaAssetId: thumbId,
      thumbnailStatus: "PENDING",
    },
  });
  const job = await db.publishJob.create({
    data: { postTargetId: youtube.id, runAt: new Date(), idempotencyKey: `vitest-${youtube.id}`, state: "WAITING" },
  });
  const instagram = seed.withInstagram
    ? await db.postTarget.create({
        data: {
          postId: post.id,
          socialAccountId: instagramAccountId,
          platform: "INSTAGRAM",
          contentType: "REEL",
          status: "PENDING",
          scheduledAt: seed.scheduledAt,
        },
      })
    : null;
  return { postId: post.id, youtubeId: youtube.id, instagramId: instagram?.id, idempotencyKey: job.idempotencyKey };
}

function publishJob(postTargetId: string, idempotencyKey: string) {
  return [{ id: "job-1", data: { postTargetId, idempotencyKey }, retryCount: 0, retryLimit: 3 }] as unknown as JobWithMetadata<{
    postTargetId: string;
    idempotencyKey: string;
  }>[];
}

beforeAll(async () => {
  await db.user.deleteMany({ where: { email: TEST_EMAIL } });
  const user = await db.user.create({ data: { email: TEST_EMAIL, passwordHash: "x", name: "Vitest" } });
  userId = user.id;
  youtubeAccountId = (
    await db.socialAccount.create({
      data: {
        userId,
        platform: "YOUTUBE",
        platformAccountId: `UC_native_${user.id}`,
        username: "Chaîne",
        accessTokenEnc: "x",
        refreshTokenEnc: "refresh",
        grantedScopes: ["https://www.googleapis.com/auth/youtube.upload"],
      },
    })
  ).id;
  instagramAccountId = (
    await db.socialAccount.create({
      data: { userId, platform: "INSTAGRAM", platformAccountId: `ig_native_${user.id}`, username: "moha", accessTokenEnc: "x" },
    })
  ).id;
  videoId = (
    await db.mediaAsset.create({
      data: { userId, storageKey: "media/vitest-native/short.mp4", mimeType: "video/mp4", sizeBytes: 1000, status: "READY" },
    })
  ).id;
  thumbId = (
    await db.mediaAsset.create({
      data: { userId, storageKey: "media/vitest-native/mini.jpg", mimeType: "image/jpeg", sizeBytes: 100, status: "READY" },
    })
  ).id;
});

beforeEach(() => {
  sent.length = 0;
  boss.send.mockClear();
  vi.mocked(publishYouTubeShort).mockReset();
  vi.mocked(fetchYouTubeVideoSummary).mockReset();
  vi.mocked(deleteYouTubeVideo).mockReset();
  vi.mocked(unscheduleYouTubeVideo).mockReset();
});

afterAll(async () => {
  await db.user.deleteMany({ where: { email: TEST_EMAIL } });
});

describe("programmation : quand part la vidéo YouTube ?", () => {
  it("publique, 2 h à l'avance : job YouTube TOUT DE SUITE, horaire de publication gardé ; Instagram à l'heure", async () => {
    const T = new Date(Date.now() + 120 * MINUTE);
    const { postId, youtubeId, instagramId } = await seedPost({ scheduledAt: T, withInstagram: true, postStatus: "DRAFT" });
    await db.publishJob.deleteMany({ where: { postTarget: { postId } } });

    expect(await schedulePost(postId, T, "Europe/Paris")).toEqual({});
    const jobs = await db.publishJob.findMany({ where: { postTarget: { postId } } });
    const ytJob = jobs.find((j) => j.postTargetId === youtubeId)!;
    const igJob = jobs.find((j) => j.postTargetId === instagramId)!;
    expect(Math.abs(ytJob.runAt.getTime() - Date.now())).toBeLessThan(10_000);
    expect(igJob.runAt.getTime()).toBe(T.getTime());
    expect((await db.postTarget.findUniqueOrThrow({ where: { id: youtubeId } })).scheduledAt?.getTime()).toBe(T.getTime());
    const ytSend = sent.find((s) => s.data.postTargetId === youtubeId)!;
    expect(Math.abs((ytSend.options.startAfter as Date).getTime() - Date.now())).toBeLessThan(10_000);
  });

  it("non répertoriée, ou moins de 15 min à l'avance : job à l'heure (publication directe)", async () => {
    const T = new Date(Date.now() + 120 * MINUTE);
    const unlisted = await seedPost({ scheduledAt: T, options: { privacy: "unlisted" }, postStatus: "DRAFT" });
    await db.publishJob.deleteMany({ where: { postTarget: { postId: unlisted.postId } } });
    await schedulePost(unlisted.postId, T, "Europe/Paris");
    expect((await db.publishJob.findFirstOrThrow({ where: { postTargetId: unlisted.youtubeId } })).runAt.getTime()).toBe(T.getTime());

    const soon = new Date(Date.now() + 10 * MINUTE);
    const close = await seedPost({ scheduledAt: soon, postStatus: "DRAFT" });
    await db.publishJob.deleteMany({ where: { postTarget: { postId: close.postId } } });
    await schedulePost(close.postId, soon, "Europe/Paris");
    expect((await db.publishJob.findFirstOrThrow({ where: { postTargetId: close.youtubeId } })).runAt.getTime()).toBe(soon.getTime());
  });
});

describe("envoi anticipé (worker)", () => {
  it("vidéo privée + publishAt → PLATFORM_SCHEDULED, vérification et miniature programmées ; un 2e passage ne renvoie RIEN", async () => {
    const T = new Date(Date.now() + 120 * MINUTE);
    const { postId, youtubeId, idempotencyKey } = await seedPost({ scheduledAt: T });
    vi.mocked(publishYouTubeShort).mockResolvedValue({
      platformPostId: "yt_native_1",
      platformPostUrl: "https://www.youtube.com/shorts/yt_native_1",
    });

    await handlePublishBatch(publishJob(youtubeId, idempotencyKey));

    expect(publishYouTubeShort).toHaveBeenCalledTimes(1);
    const params = vi.mocked(publishYouTubeShort).mock.calls[0][0];
    expect(params.publishAt?.getTime()).toBe(T.getTime());
    expect(params.privacyStatus).toBe("public");
    const target = await db.postTarget.findUniqueOrThrow({ where: { id: youtubeId } });
    expect(target.status).toBe("PLATFORM_SCHEDULED");
    expect(target.platformPostId).toBe("yt_native_1");
    expect(target.publishedAt).toBeNull();
    expect((await db.post.findUniqueOrThrow({ where: { id: postId } })).status).toBe("SCHEDULED");

    const confirm = sent.find((s) => s.queue === "youtube-publication")!;
    expect(confirm.data).toEqual({ postTargetId: youtubeId, videoId: "yt_native_1", check: 1 });
    expect((confirm.options.startAfter as Date).getTime()).toBe(T.getTime() + MINUTE);
    expect(sent.find((s) => s.queue === "youtube-thumbnail")?.data).toMatchObject({ kind: "processing", check: 1 });
    const log = await db.activityLog.findFirstOrThrow({ where: { entityId: youtubeId, action: "youtube_scheduled" } });
    expect(log.detail).toMatchObject({ videoId: "yt_native_1", publishAt: T.toISOString(), delivery: { via: "worker" } });

    // Rejeu du job (retry pg-boss, réconciliation) : la vidéo est chez YouTube, on ne la renvoie jamais.
    await handlePublishBatch(publishJob(youtubeId, idempotencyKey));
    expect(publishYouTubeShort).toHaveBeenCalledTimes(1);
  });
});

describe("vérification à l'heure prévue", () => {
  it("publique → PUBLISHED, post publié, journal youtube_published avec le chemin du fichier", async () => {
    const T = new Date(Date.now() - 2 * MINUTE);
    const { postId, youtubeId } = await seedPost({ scheduledAt: T, status: "PLATFORM_SCHEDULED", platformPostId: "yt_pub" });
    await db.activityLog.create({
      data: { userId, entityType: "PostTarget", entityId: youtubeId, action: "youtube_scheduled", detail: { delivery: { via: "worker", method: "worker_push" } } },
    });
    vi.mocked(fetchYouTubeVideoSummary).mockResolvedValue({ privacyStatus: "public", thumbnails: {} });

    await runYouTubePublicationCheck({ postTargetId: youtubeId, videoId: "yt_pub", check: 1 });
    const target = await db.postTarget.findUniqueOrThrow({ where: { id: youtubeId } });
    expect(target.status).toBe("PUBLISHED");
    expect(target.publishedAt?.getTime()).toBe(T.getTime());
    expect((await db.post.findUniqueOrThrow({ where: { id: postId } })).status).toBe("PUBLISHED");
    const log = await db.activityLog.findFirstOrThrow({ where: { entityId: youtubeId, action: "youtube_published" } });
    expect(log.detail).toMatchObject({ delivery: { via: "worker", method: "worker_push" } });

    // Une seconde vérification (doublon de job) ne refait rien.
    await runYouTubePublicationCheck({ postTargetId: youtubeId, videoId: "yt_pub", check: 2 });
    expect(await db.activityLog.count({ where: { entityId: youtubeId, action: "youtube_published" } })).toBe(1);
  });

  it("encore privée → nouvelle vérification ; date déplacée dans Studio → l'heure suit ; supprimée → échec expliqué", async () => {
    const T = new Date(Date.now() - MINUTE);
    const a = await seedPost({ scheduledAt: T, status: "PLATFORM_SCHEDULED", platformPostId: "yt_wait" });
    vi.mocked(fetchYouTubeVideoSummary).mockResolvedValueOnce({ privacyStatus: "private", publishAt: T.toISOString(), thumbnails: {} });
    await runYouTubePublicationCheck({ postTargetId: a.youtubeId, videoId: "yt_wait", check: 1 });
    expect(sent.at(-1)?.data).toEqual({ postTargetId: a.youtubeId, videoId: "yt_wait", check: 2 });
    expect((await db.postTarget.findUniqueOrThrow({ where: { id: a.youtubeId } })).status).toBe("PLATFORM_SCHEDULED");

    const later = new Date(Date.now() + 90 * MINUTE);
    vi.mocked(fetchYouTubeVideoSummary).mockResolvedValueOnce({ privacyStatus: "private", publishAt: later.toISOString(), thumbnails: {} });
    await runYouTubePublicationCheck({ postTargetId: a.youtubeId, videoId: "yt_wait", check: 7 });
    expect((await db.postTarget.findUniqueOrThrow({ where: { id: a.youtubeId } })).scheduledAt?.getTime()).toBe(later.getTime());
    expect(sent.at(-1)?.data).toEqual({ postTargetId: a.youtubeId, videoId: "yt_wait", check: 1 });
    expect((sent.at(-1)?.options.startAfter as Date).getTime()).toBe(later.getTime() + MINUTE);

    const b = await seedPost({ scheduledAt: T, status: "PLATFORM_SCHEDULED", platformPostId: "yt_gone" });
    vi.mocked(fetchYouTubeVideoSummary).mockResolvedValueOnce(null);
    await runYouTubePublicationCheck({ postTargetId: b.youtubeId, videoId: "yt_gone", check: 1 });
    const gone = await db.postTarget.findUniqueOrThrow({ where: { id: b.youtubeId } });
    expect(gone.status).toBe("FAILED");
    expect(gone.errorCode).toBe("yt_scheduled_missing");
  });

  it("toujours privée 1 h après l'heure : échec expliqué (« restée privée »)", async () => {
    const { youtubeId } = await seedPost({ scheduledAt: new Date(Date.now() - 61 * MINUTE), status: "PLATFORM_SCHEDULED", platformPostId: "yt_stuck" });
    vi.mocked(fetchYouTubeVideoSummary).mockResolvedValueOnce({ privacyStatus: "private", thumbnails: {} });
    await runYouTubePublicationCheck({ postTargetId: youtubeId, videoId: "yt_stuck", check: 30 });
    const target = await db.postTarget.findUniqueOrThrow({ where: { id: youtubeId } });
    expect(target.status).toBe("FAILED");
    expect(target.errorCode).toBe("yt_scheduled_not_public");
  });
});

describe("annulation / reprogrammation d'une vidéo programmée chez YouTube", () => {
  it("encore privée : supprimée chez YouTube, cible remise en attente sans référence, miniature à reposer", async () => {
    const T = new Date(Date.now() + 120 * MINUTE);
    const { postId, youtubeId } = await seedPost({ scheduledAt: T, status: "PLATFORM_SCHEDULED", platformPostId: "yt_cancel" });
    await db.postTarget.update({ where: { id: youtubeId }, data: { thumbnailStatus: "SET" } });
    vi.mocked(fetchYouTubeVideoSummary).mockResolvedValue({ privacyStatus: "private", publishAt: T.toISOString(), thumbnails: {} });

    expect(await unschedulePostForUser(userId, postId)).toEqual({});
    expect(deleteYouTubeVideo).toHaveBeenCalledWith("yt-token", "yt_cancel");
    const target = await db.postTarget.findUniqueOrThrow({ where: { id: youtubeId } });
    expect(target.status).toBe("PENDING");
    expect(target.platformPostId).toBeNull();
    expect(target.thumbnailStatus).toBe("PENDING");
    expect((await db.post.findUniqueOrThrow({ where: { id: postId } })).status).toBe("DRAFT");
  });

  it("déjà publique (heure passée, vérification pas encore faite) : rien n'est supprimé, la cible devient PUBLISHED", async () => {
    const { postId, youtubeId } = await seedPost({ scheduledAt: new Date(Date.now() - MINUTE), status: "PLATFORM_SCHEDULED", platformPostId: "yt_live" });
    vi.mocked(fetchYouTubeVideoSummary).mockResolvedValue({ privacyStatus: "public", thumbnails: {} });
    expect(await unschedulePostForUser(userId, postId)).toEqual({});
    expect(deleteYouTubeVideo).not.toHaveBeenCalled();
    const target = await db.postTarget.findUniqueOrThrow({ where: { id: youtubeId } });
    expect(target.status).toBe("PUBLISHED");
    expect(target.platformPostId).toBe("yt_live");
  });

  it("suppression refusée → repli « privée sans date » ; YouTube injoignable → erreur et RIEN n'est modifié", async () => {
    const T = new Date(Date.now() + 120 * MINUTE);
    const a = await seedPost({ scheduledAt: T, status: "PLATFORM_SCHEDULED", platformPostId: "yt_fallback" });
    vi.mocked(fetchYouTubeVideoSummary).mockResolvedValue({ privacyStatus: "private", publishAt: T.toISOString(), thumbnails: {} });
    vi.mocked(deleteYouTubeVideo).mockRejectedValueOnce(new Error("Suppression de la vidéo YouTube échouée (403): {}"));
    expect(await unschedulePostForUser(userId, a.postId)).toEqual({});
    expect(unscheduleYouTubeVideo).toHaveBeenCalledWith("yt-token", "yt_fallback");

    const b = await seedPost({ scheduledAt: T, status: "PLATFORM_SCHEDULED", platformPostId: "yt_unreachable" });
    vi.mocked(fetchYouTubeVideoSummary).mockRejectedValueOnce(new TypeError("fetch failed"));
    const result = await unschedulePostForUser(userId, b.postId);
    expect(result.error).toMatch(/Impossible d'annuler la vidéo programmée chez YouTube/);
    expect((await db.postTarget.findUniqueOrThrow({ where: { id: b.youtubeId } })).status).toBe("PLATFORM_SCHEDULED");
    expect((await db.post.findUniqueOrThrow({ where: { id: b.postId } })).status).toBe("SCHEDULED");
    expect(await db.publishJob.count({ where: { postTargetId: b.youtubeId } })).toBe(1);
  });

  it("reprogrammation : vidéo supprimée chez YouTube puis nouvel envoi immédiat pour le nouvel horaire", async () => {
    const T = new Date(Date.now() + 120 * MINUTE);
    const { postId, youtubeId } = await seedPost({ scheduledAt: T, status: "PLATFORM_SCHEDULED", platformPostId: "yt_move" });
    vi.mocked(fetchYouTubeVideoSummary).mockResolvedValue({ privacyStatus: "private", publishAt: T.toISOString(), thumbnails: {} });
    const newT = new Date(Date.now() + 240 * MINUTE);

    expect(await reschedulePost(postId, newT, "Europe/Paris")).toEqual({});
    expect(deleteYouTubeVideo).toHaveBeenCalledWith("yt-token", "yt_move");
    const target = await db.postTarget.findUniqueOrThrow({ where: { id: youtubeId } });
    expect(target.status).toBe("PENDING");
    expect(target.scheduledAt?.getTime()).toBe(newT.getTime());
    const job = await db.publishJob.findFirstOrThrow({ where: { postTargetId: youtubeId } });
    expect(Math.abs(job.runAt.getTime() - Date.now())).toBeLessThan(10_000);
  });
});
