// Test d'intégration du moment de dépôt des brouillons TikTok (CLAUDE.md §41) : vraies requêtes Prisma
// contre la base de dev locale, pg-boss simulé. On vérifie : le choix gardé d'une modification de
// brouillon à l'autre (trois états), le job TikTok à l'heure prévue par défaut ou tout de suite sur
// demande, et le plafond de 5 brouillons / 24 h mesuré autour de l'heure de DÉPÔT (une semaine de Shorts
// programmée d'un coup ne bloque plus).
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
const { formatInTimeZone } = await import("date-fns-tz");

const TEST_EMAIL = "vitest-tiktok-timing@test.local";
const HOUR = 3_600_000;
let userId: string;
let videoId: string;

const tiktokOnly = (extra: Record<string, unknown> = {}) => ({
  caption: "Short",
  hashtags: [],
  mediaAssetIds: [videoId],
  targetInstagram: false,
  targetInstagramStory: false,
  targetTiktok: true,
  targetYoutube: false,
  ...extra,
});

const tiktokTarget = (postId: string) => db.postTarget.findFirstOrThrow({ where: { postId, platform: "TIKTOK" } });
const local = (d: Date) => formatInTimeZone(d, "Europe/Paris", "yyyy-MM-dd'T'HH:mm");

beforeAll(async () => {
  await db.user.deleteMany({ where: { email: TEST_EMAIL } });
  userId = (await db.user.create({ data: { email: TEST_EMAIL, passwordHash: "x", name: "Vitest" } })).id;
  await db.socialAccount.create({
    data: { userId, platform: "TIKTOK", platformAccountId: `tt_timing_${userId}`, username: "Pokemoha", accessTokenEnc: "x" },
  });
  videoId = (
    await db.mediaAsset.create({
      data: { userId, storageKey: "media/vitest-tt/short.mp4", mimeType: "video/mp4", sizeBytes: 1000, status: "READY", width: 1080, height: 1920, durationSec: 40 },
    })
  ).id;
});

afterAll(async () => {
  await db.user.deleteMany({ where: { email: TEST_EMAIL } });
});

describe("choix du moment de dépôt sur le brouillon", () => {
  it("défaut = à l'heure prévue ; « now » gardé quand le champ est absent ; null = retour au défaut", async () => {
    const created = await saveDraftForUser(userId, tiktokOnly());
    expect((await tiktokTarget(created.postId!)).platformOptions).toEqual({});

    const now = await saveDraftForUser(userId, tiktokOnly({ postId: created.postId, tiktokDraftTiming: "now" }));
    expect((await tiktokTarget(now.postId!)).platformOptions).toEqual({ draftTiming: "now" });

    const kept = await saveDraftForUser(userId, tiktokOnly({ postId: created.postId, caption: "Autre légende" }));
    expect((await tiktokTarget(kept.postId!)).platformOptions).toEqual({ draftTiming: "now" });

    const reset = await saveDraftForUser(userId, tiktokOnly({ postId: created.postId, tiktokDraftTiming: null }));
    expect((await tiktokTarget(reset.postId!)).platformOptions).toEqual({});
  });
});

describe("programmation", () => {
  it("à l'heure prévue : job TikTok à l'heure du post ; « now » : job tout de suite", async () => {
    const at = new Date(Math.ceil((Date.now() + 3 * HOUR) / 60_000) * 60_000);

    const scheduled = await saveDraftForUser(userId, tiktokOnly());
    expect(await schedulePostForUser(userId, scheduled.postId!, local(at), "Europe/Paris")).toEqual({});
    const scheduledTarget = await tiktokTarget(scheduled.postId!);
    expect(scheduledTarget.scheduledAt?.getTime()).toBe(at.getTime());
    expect((await db.publishJob.findFirstOrThrow({ where: { postTargetId: scheduledTarget.id } })).runAt.getTime()).toBe(at.getTime());

    const immediate = await saveDraftForUser(userId, tiktokOnly({ tiktokDraftTiming: "now" }));
    expect(await schedulePostForUser(userId, immediate.postId!, local(at), "Europe/Paris")).toEqual({});
    const immediateTarget = await tiktokTarget(immediate.postId!);
    const job = await db.publishJob.findFirstOrThrow({ where: { postTargetId: immediateTarget.id } });
    expect(Math.abs(job.runAt.getTime() - Date.now())).toBeLessThan(10_000);

    await db.post.deleteMany({ where: { id: { in: [scheduled.postId!, immediate.postId!] } } });
  });

  it("une semaine de Shorts programmée d'un coup : le plafond de 5 / 24 h est mesuré jour par jour", async () => {
    const firstDay = new Date(Math.ceil((Date.now() + 26 * HOUR) / 60_000) * 60_000);
    const ids: string[] = [];
    for (let day = 0; day < 7; day++) {
      const draft = await saveDraftForUser(userId, tiktokOnly({ caption: `Jour ${day}` }));
      ids.push(draft.postId!);
      const at = new Date(firstDay.getTime() + day * 24 * HOUR);
      expect(await schedulePostForUser(userId, draft.postId!, local(at), "Europe/Paris")).toEqual({});
    }

    // Le jour du 1er, 4 brouillons de plus passent (5 dans la fenêtre de 24 h) ; le 6e est refusé.
    for (let extra = 1; extra <= 5; extra++) {
      const draft = await saveDraftForUser(userId, tiktokOnly({ caption: `Extra ${extra}` }));
      ids.push(draft.postId!);
      const at = new Date(firstDay.getTime() + extra * 60_000);
      const result = await schedulePostForUser(userId, draft.postId!, local(at), "Europe/Paris");
      if (extra <= 4) expect(result).toEqual({});
      else expect(result.error).toMatch(/TikTok limite à 5 brouillons/);
    }

    await db.post.deleteMany({ where: { id: { in: ids } } });
  });
});
