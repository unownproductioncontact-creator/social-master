// Test d'intégration de la modification d'une vidéo déjà sur YouTube (CLAUDE.md §39) : vraies requêtes
// Prisma contre la base de dev locale ; YouTube, pg-boss, Telegram et le chiffrement des jetons sont
// simulés. On vérifie les ÉTATS : ce qui part chez YouTube, ce que la base retient, ce qui est refusé
// avant tout appel, et la reprogrammation « sur place » d'une vidéo programmée chez YouTube.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

const sent: Array<{ queue: string; data: Record<string, unknown>; options: Record<string, unknown> }> = [];
const defaultSend = async (queue: string, data: Record<string, unknown>, options: Record<string, unknown> = {}) => {
  sent.push({ queue, data, options });
  return "job-id";
};
const boss = { send: vi.fn(defaultSend), cancel: vi.fn(async () => {}) };

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
  refreshYouTubeAccessToken: vi.fn(),
  fetchYouTubeVideoSummary: vi.fn(),
  deleteYouTubeVideo: vi.fn(),
  unscheduleYouTubeVideo: vi.fn(),
  setYouTubeThumbnail: vi.fn(),
  fetchYouTubeVideoDetails: vi.fn(),
  listYouTubeChannelVideos: vi.fn(),
  updateYouTubeVideo: vi.fn(),
}));
vi.mock("@/lib/youtube-token", () => ({ freshYouTubeAccessToken: vi.fn(async () => "yt-token") }));
vi.mock("@/lib/telegram", () => ({ notifyTelegram: vi.fn(async () => {}) }));

const { db } = await import("@/lib/db");
const { reschedulePost } = await import("@/lib/scheduler");
const { getYouTubeVideoForUser, listYouTubeVideosForUser, updateYouTubeVideoForUser } = await import(
  "@/lib/youtube-video-edit-service"
);
const {
  fetchYouTubeVideoDetails,
  fetchYouTubeVideoSummary,
  updateYouTubeVideo,
  deleteYouTubeVideo,
  listYouTubeChannelVideos,
  publishYouTubeShort,
} = await import("@/lib/providers/youtube");
type Details = import("@/lib/youtube-video-edit").YouTubeVideoDetails;

const TEST_EMAIL = "vitest-yt-edit@test.local";
const MINUTE = 60_000;
const EDIT_SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/youtube.force-ssl",
];

let userId: string;
let channelId: string;
let youtubeAccountId: string;
let instagramAccountId: string;
let videoMediaId: string;
let thumbId: string;

function details(overrides: Partial<Details> = {}): Details {
  return {
    id: "vid_pub_001",
    channelId,
    title: "Ancien titre",
    description: "Description d'origine\n\n#pokemon",
    tags: ["pokemon"],
    categoryId: "20",
    defaultAudioLanguage: "fr",
    privacyStatus: "public",
    uploadStatus: "processed",
    embeddable: true,
    license: "youtube",
    publicStatsViewable: true,
    durationSec: 58,
    ...overrides,
  };
}

type Seed = {
  status: "PENDING" | "PUBLISHED" | "PLATFORM_SCHEDULED";
  platformPostId?: string;
  scheduledAt?: Date;
  withInstagram?: boolean;
  postStatus?: "SCHEDULED" | "PUBLISHED";
  options?: Record<string, string>;
};

async function seed(s: Seed) {
  const post = await db.post.create({
    data: {
      userId,
      caption: "Short",
      status: s.postStatus ?? (s.status === "PUBLISHED" ? "PUBLISHED" : "SCHEDULED"),
      scheduledAt: s.scheduledAt ?? null,
    },
  });
  await db.postMedia.create({ data: { postId: post.id, mediaAssetId: videoMediaId, position: 0 } });
  const youtube = await db.postTarget.create({
    data: {
      postId: post.id,
      socialAccountId: youtubeAccountId,
      platform: "YOUTUBE",
      contentType: "YOUTUBE_SHORT",
      status: s.status,
      scheduledAt: s.scheduledAt ?? null,
      platformOptions: s.options ?? {},
      platformPostId: s.platformPostId ?? null,
      platformPostUrl: s.platformPostId ? `https://www.youtube.com/shorts/${s.platformPostId}` : null,
      coverMediaAssetId: thumbId,
      thumbnailStatus: "SET",
    },
  });
  const job = await db.publishJob.create({
    data: { postTargetId: youtube.id, runAt: new Date(), idempotencyKey: `vitest-edit-${youtube.id}`, state: "COMPLETED" },
  });
  const instagram = s.withInstagram
    ? await db.postTarget.create({
        data: {
          postId: post.id,
          socialAccountId: instagramAccountId,
          platform: "INSTAGRAM",
          contentType: "REEL",
          status: "PENDING",
          scheduledAt: s.scheduledAt ?? null,
        },
      })
    : null;
  return { postId: post.id, youtubeId: youtube.id, instagramId: instagram?.id, idempotencyKey: job.idempotencyKey };
}

beforeAll(async () => {
  await db.user.deleteMany({ where: { email: TEST_EMAIL } });
  const user = await db.user.create({ data: { email: TEST_EMAIL, passwordHash: "x", name: "Vitest" } });
  userId = user.id;
  channelId = `UC_edit_${user.id}`;
  youtubeAccountId = (
    await db.socialAccount.create({
      data: {
        userId,
        platform: "YOUTUBE",
        platformAccountId: channelId,
        username: "Pokemoha",
        accessTokenEnc: "x",
        refreshTokenEnc: "refresh",
        grantedScopes: EDIT_SCOPES,
      },
    })
  ).id;
  instagramAccountId = (
    await db.socialAccount.create({
      data: { userId, platform: "INSTAGRAM", platformAccountId: `ig_edit_${user.id}`, username: "moha", accessTokenEnc: "x" },
    })
  ).id;
  videoMediaId = (
    await db.mediaAsset.create({
      data: { userId, storageKey: "media/vitest-edit/short.mp4", mimeType: "video/mp4", sizeBytes: 1000, status: "READY" },
    })
  ).id;
  thumbId = (
    await db.mediaAsset.create({
      data: { userId, storageKey: "media/vitest-edit/mini.jpg", mimeType: "image/jpeg", sizeBytes: 100, status: "READY" },
    })
  ).id;
});

beforeEach(() => {
  sent.length = 0;
  boss.send.mockReset();
  boss.send.mockImplementation(defaultSend);
  for (const fn of [fetchYouTubeVideoDetails, fetchYouTubeVideoSummary, updateYouTubeVideo, deleteYouTubeVideo, listYouTubeChannelVideos, publishYouTubeShort]) {
    vi.mocked(fn).mockReset();
  }
});

afterAll(async () => {
  await db.user.deleteMany({ where: { email: TEST_EMAIL } });
});

describe("modifier une vidéo publiée", () => {
  it("par post_id : seuls les champs demandés changent chez YouTube, la cible et le journal suivent", async () => {
    const { postId, youtubeId } = await seed({ status: "PUBLISHED", platformPostId: "vid_pub_001", options: { title: "Ancien titre" } });
    vi.mocked(fetchYouTubeVideoDetails).mockResolvedValue(details());
    vi.mocked(updateYouTubeVideo).mockImplementation(async (_t, _p, body) => body);

    const result = await updateYouTubeVideoForUser(userId, { postId }, { title: "  Nouveau titre ", privacy: "unlisted" });
    expect(result.error).toBeUndefined();
    expect(result.changes?.map((c) => c.field)).toEqual(["title", "privacy"]);
    expect(updateYouTubeVideo).toHaveBeenCalledWith("yt-token", ["snippet", "status"], {
      id: "vid_pub_001",
      snippet: {
        title: "Nouveau titre",
        description: "Description d'origine\n\n#pokemon",
        tags: ["pokemon"],
        categoryId: "20",
        defaultAudioLanguage: "fr",
      },
      status: { privacyStatus: "unlisted", embeddable: true, license: "youtube", publicStatsViewable: true },
    });
    const target = await db.postTarget.findUniqueOrThrow({ where: { id: youtubeId } });
    expect(target.platformOptions).toEqual({ title: "Nouveau titre", privacy: "unlisted" });
    const log = await db.activityLog.findFirstOrThrow({ where: { entityId: youtubeId, action: "youtube_video_updated" } });
    expect((log.detail as { changes: Array<{ field: string }> }).changes.map((c) => c.field)).toEqual(["title", "privacy"]);
    expect(result.video?.title).toBe("Nouveau titre");
  });

  it("vidéo hors Social Master, par lien : modifiée, journal au nom de la vidéo", async () => {
    vi.mocked(fetchYouTubeVideoDetails).mockResolvedValue(details({ id: "extVideo123" }));
    vi.mocked(updateYouTubeVideo).mockImplementation(async (_t, _p, body) => body);
    const result = await updateYouTubeVideoForUser(userId, { video: "https://youtu.be/extVideo123?si=x" }, { tags: ["#Pokemon", "booster"] });
    expect(result.error).toBeUndefined();
    expect(result.postId).toBeUndefined();
    expect(vi.mocked(updateYouTubeVideo).mock.calls[0][2]).toMatchObject({ snippet: { tags: ["Pokemon", "booster"] } });
    expect(await db.activityLog.count({ where: { entityType: "YouTubeVideo", entityId: "extVideo123", action: "youtube_video_updated" } })).toBe(1);
  });

  it("vidéo d'une autre chaîne → refus, rien n'est envoyé", async () => {
    vi.mocked(fetchYouTubeVideoDetails).mockResolvedValue(details({ id: "otherChan01", channelId: "UC_quelqu_un_d_autre" }));
    const result = await updateYouTubeVideoForUser(userId, { video: "otherChan01" }, { title: "Pirate" });
    expect(result.code).toBe("yt_edit_not_owned");
    expect(updateYouTubeVideo).not.toHaveBeenCalled();
  });

  it("connexion sans le droit de modification → message de reconnexion, rien n'est envoyé", async () => {
    await db.socialAccount.update({ where: { id: youtubeAccountId }, data: { grantedScopes: EDIT_SCOPES.slice(0, 2) } });
    try {
      vi.mocked(fetchYouTubeVideoDetails).mockResolvedValue(details());
      const result = await updateYouTubeVideoForUser(userId, { video: "vid_pub_001" }, { title: "Nouveau" });
      expect(result.code).toBe("yt_edit_scope");
      expect(result.error).toMatch(/Reconnecter/);
      expect(updateYouTubeVideo).not.toHaveBeenCalled();
      expect((await getYouTubeVideoForUser(userId, { video: "vid_pub_001" })).editScope).toBe("missing");
    } finally {
      await db.socialAccount.update({ where: { id: youtubeAccountId }, data: { grantedScopes: EDIT_SCOPES } });
    }
  });

  it("YouTube refuse → message clair, base et journal inchangés", async () => {
    const { postId, youtubeId } = await seed({ status: "PUBLISHED", platformPostId: "vid_pub_002", options: { title: "Ancien titre" } });
    vi.mocked(fetchYouTubeVideoDetails).mockResolvedValue(details({ id: "vid_pub_002" }));
    vi.mocked(updateYouTubeVideo).mockRejectedValue(
      new Error('Modification de la vidéo YouTube refusée (400): {"error":{"code":400,"errors":[{"reason":"invalidTitle"}]}}')
    );
    const result = await updateYouTubeVideoForUser(userId, { postId }, { title: "Refusé" });
    expect(result.error).toMatch(/titre/);
    expect((await db.postTarget.findUniqueOrThrow({ where: { id: youtubeId } })).platformOptions).toEqual({ title: "Ancien titre" });
    expect(await db.activityLog.count({ where: { entityId: youtubeId, action: "youtube_video_updated" } })).toBe(0);
  });

  it("valeurs identiques → aucun appel ; vidéo pas encore chez YouTube → explication", async () => {
    vi.mocked(fetchYouTubeVideoDetails).mockResolvedValue(details());
    const same = await updateYouTubeVideoForUser(userId, { video: "vid_pub_001" }, { title: "Ancien titre" });
    expect(same.notes?.[0]).toMatch(/Rien n'a changé/);
    expect(updateYouTubeVideo).not.toHaveBeenCalled();

    const { postId } = await seed({ status: "PENDING", scheduledAt: new Date(Date.now() + 10 * MINUTE) });
    expect((await updateYouTubeVideoForUser(userId, { postId }, { title: "x" })).error).toMatch(/pas encore chez YouTube/);
  });
});

describe("vidéo programmée chez YouTube par Social Master (§38)", () => {
  it("nouvelle date : privée + publishAt chez YouTube, la cible et le post suivent, vérification à la nouvelle heure", async () => {
    const T = new Date(Date.now() + 120 * MINUTE);
    const newT = new Date(Date.now() + 300 * MINUTE);
    const { postId, youtubeId } = await seed({ status: "PLATFORM_SCHEDULED", platformPostId: "vid_sched_1", scheduledAt: T });
    vi.mocked(fetchYouTubeVideoDetails).mockResolvedValue(details({ id: "vid_sched_1", privacyStatus: "private", publishAt: T.toISOString() }));
    vi.mocked(updateYouTubeVideo).mockImplementation(async (_t, _p, body) => body);

    const result = await updateYouTubeVideoForUser(userId, { postId }, { publishAt: newT });
    expect(result.error).toBeUndefined();
    expect(vi.mocked(updateYouTubeVideo).mock.calls[0][2]).toMatchObject({
      status: { privacyStatus: "private", publishAt: newT.toISOString() },
    });
    expect((await db.postTarget.findUniqueOrThrow({ where: { id: youtubeId } })).scheduledAt?.getTime()).toBe(newT.getTime());
    expect((await db.post.findUniqueOrThrow({ where: { id: postId } })).scheduledAt?.getTime()).toBe(newT.getTime());
    const check = sent.find((s) => s.queue === "youtube-publication")!;
    expect(check.data).toEqual({ postTargetId: youtubeId, videoId: "vid_sched_1", check: 1 });
    expect((check.options.startAfter as Date).getTime()).toBe(newT.getTime() + MINUTE);
    expect(await db.activityLog.count({ where: { entityId: youtubeId, action: "youtube_schedule_moved" } })).toBe(1);
  });

  it("« public » = publication immédiate : vérification tout de suite ; « non répertoriée » refusée", async () => {
    const T = new Date(Date.now() + 120 * MINUTE);
    const { postId, youtubeId } = await seed({ status: "PLATFORM_SCHEDULED", platformPostId: "vid_sched_2", scheduledAt: T });
    vi.mocked(fetchYouTubeVideoDetails).mockResolvedValue(details({ id: "vid_sched_2", privacyStatus: "private", publishAt: T.toISOString() }));
    vi.mocked(updateYouTubeVideo).mockImplementation(async (_t, _p, body) => body);

    const unlisted = await updateYouTubeVideoForUser(userId, { postId }, { privacy: "unlisted" });
    expect(unlisted.error).toMatch(/programmée par Social Master/);
    expect(updateYouTubeVideo).not.toHaveBeenCalled();

    const now = await updateYouTubeVideoForUser(userId, { postId }, { privacy: "public" });
    expect(now.notes?.join(" ")).toMatch(/publiée tout de suite/);
    expect(vi.mocked(updateYouTubeVideo).mock.calls[0][2]).toMatchObject({ status: { privacyStatus: "public" } });
    const check = sent.find((s) => s.queue === "youtube-publication")!;
    expect(check.data).toMatchObject({ postTargetId: youtubeId, check: 1 });
    expect(Math.abs((check.options.startAfter as Date).getTime() - Date.now())).toBeLessThan(10_000);
  });
});

describe("reprogrammation : déplacement sur place (§39)", () => {
  it("même vidéo déplacée chez YouTube (rien supprimé ni renvoyé, miniature gardée), Instagram reprogrammé", async () => {
    const T = new Date(Date.now() + 120 * MINUTE);
    const newT = new Date(Date.now() + 240 * MINUTE);
    const { postId, youtubeId, instagramId, idempotencyKey } = await seed({
      status: "PLATFORM_SCHEDULED",
      platformPostId: "vid_move_1",
      scheduledAt: T,
      withInstagram: true,
    });
    vi.mocked(fetchYouTubeVideoDetails).mockResolvedValue(details({ id: "vid_move_1", privacyStatus: "private", publishAt: T.toISOString() }));
    vi.mocked(updateYouTubeVideo).mockImplementation(async (_t, _p, body) => body);

    expect(await reschedulePost(postId, newT, "Europe/Paris")).toEqual({});
    expect(vi.mocked(updateYouTubeVideo).mock.calls[0][2]).toMatchObject({ status: { publishAt: newT.toISOString() } });
    expect(deleteYouTubeVideo).not.toHaveBeenCalled();
    expect(publishYouTubeShort).not.toHaveBeenCalled();

    const youtube = await db.postTarget.findUniqueOrThrow({ where: { id: youtubeId } });
    expect(youtube).toMatchObject({ status: "PLATFORM_SCHEDULED", platformPostId: "vid_move_1", thumbnailStatus: "SET" });
    expect(youtube.scheduledAt?.getTime()).toBe(newT.getTime());
    expect((await db.publishJob.findMany({ where: { postTargetId: youtubeId } })).map((j) => j.idempotencyKey)).toEqual([idempotencyKey]);

    const instagram = await db.postTarget.findUniqueOrThrow({ where: { id: instagramId! } });
    expect(instagram.status).toBe("PENDING");
    expect(instagram.scheduledAt?.getTime()).toBe(newT.getTime());
    expect((await db.publishJob.findFirstOrThrow({ where: { postTargetId: instagramId! } })).runAt.getTime()).toBe(newT.getTime());
    const post = await db.post.findUniqueOrThrow({ where: { id: postId } });
    expect(post.status).toBe("SCHEDULED");
    expect(post.scheduledAt?.getTime()).toBe(newT.getTime());
  });

  it("post YouTube seul : rien d'autre à reprogrammer, le post suit la nouvelle heure", async () => {
    const T = new Date(Date.now() + 120 * MINUTE);
    const newT = new Date(Date.now() + 180 * MINUTE);
    const { postId, youtubeId } = await seed({ status: "PLATFORM_SCHEDULED", platformPostId: "vid_move_2", scheduledAt: T });
    vi.mocked(fetchYouTubeVideoDetails).mockResolvedValue(details({ id: "vid_move_2", privacyStatus: "private", publishAt: T.toISOString() }));
    vi.mocked(updateYouTubeVideo).mockImplementation(async (_t, _p, body) => body);

    expect(await reschedulePost(postId, newT, "Europe/Paris")).toEqual({});
    const post = await db.post.findUniqueOrThrow({ where: { id: postId } });
    expect(post).toMatchObject({ status: "SCHEDULED" });
    expect(post.scheduledAt?.getTime()).toBe(newT.getTime());
    expect((await db.postTarget.findUniqueOrThrow({ where: { id: youtubeId } })).platformPostId).toBe("vid_move_2");
  });

  it("YouTube refuse le déplacement → ancien chemin : supprimée puis renvoyée", async () => {
    const T = new Date(Date.now() + 120 * MINUTE);
    const newT = new Date(Date.now() + 240 * MINUTE);
    const { postId, youtubeId } = await seed({ status: "PLATFORM_SCHEDULED", platformPostId: "vid_move_3", scheduledAt: T });
    vi.mocked(fetchYouTubeVideoDetails).mockResolvedValue(details({ id: "vid_move_3", privacyStatus: "private", publishAt: T.toISOString() }));
    vi.mocked(updateYouTubeVideo).mockRejectedValue(new Error("Modification de la vidéo YouTube refusée (503): {}"));
    vi.mocked(fetchYouTubeVideoSummary).mockResolvedValue({ privacyStatus: "private", publishAt: T.toISOString(), thumbnails: {} });

    expect(await reschedulePost(postId, newT, "Europe/Paris")).toEqual({});
    expect(deleteYouTubeVideo).toHaveBeenCalledWith("yt-token", "vid_move_3");
    const target = await db.postTarget.findUniqueOrThrow({ where: { id: youtubeId } });
    expect(target).toMatchObject({ status: "PENDING", platformPostId: null });
  });

  it("si les autres cibles ne peuvent pas être reprogrammées, la vidéo déjà déplacée est annulée (jamais de publication orpheline)", async () => {
    const T = new Date(Date.now() + 120 * MINUTE);
    const newT = new Date(Date.now() + 240 * MINUTE);
    const { postId, youtubeId } = await seed({ status: "PLATFORM_SCHEDULED", platformPostId: "vid_move_4", scheduledAt: T, withInstagram: true });
    vi.mocked(fetchYouTubeVideoDetails).mockResolvedValue(details({ id: "vid_move_4", privacyStatus: "private", publishAt: T.toISOString() }));
    vi.mocked(updateYouTubeVideo).mockImplementation(async (_t, _p, body) => body);
    vi.mocked(fetchYouTubeVideoSummary).mockResolvedValue({ privacyStatus: "private", publishAt: newT.toISOString(), thumbnails: {} });
    boss.send.mockImplementation(async (queue, data, options = {}) => {
      if (queue === "publish") throw new Error("pg-boss indisponible");
      return defaultSend(queue, data, options);
    });

    const result = await reschedulePost(postId, newT, "Europe/Paris");
    expect(result.error).toMatch(/pg-boss indisponible/);
    expect(deleteYouTubeVideo).toHaveBeenCalledWith("yt-token", "vid_move_4");
    expect((await db.post.findUniqueOrThrow({ where: { id: postId } })).status).toBe("DRAFT");
    expect(await db.postTarget.findUniqueOrThrow({ where: { id: youtubeId } })).toMatchObject({ status: "PENDING", platformPostId: null });
  });
});

describe("vidéos de la chaîne", () => {
  it("liste avec le post Social Master de celles qui en ont un, et le droit de modification", async () => {
    const { postId } = await seed({ status: "PUBLISHED", platformPostId: "vid_listed1" });
    vi.mocked(listYouTubeChannelVideos).mockResolvedValue([details({ id: "vid_listed1" }), details({ id: "notLinked01" })]);
    const result = await listYouTubeVideosForUser(userId, 10);
    expect(result.editScope).toBe("granted");
    expect(result.videos?.map((v) => [v.id, v.postId])).toEqual([
      ["vid_listed1", postId],
      ["notLinked01", undefined],
    ]);
  });
});
