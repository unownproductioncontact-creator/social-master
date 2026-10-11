// Test d'intégration léger : exerce la vraie requête Prisma `aggregate` contre la base de dev
// locale (voir CLAUDE.md §13/§16). N'implique pas pg-boss (pas de queue), contrairement à
// scheduler.test.ts — juste db.mediaAsset.aggregate(), donc pas exposé au piège de protocole
// documenté pour les jobs pg-boss fraîchement créés.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

vi.mock("@/lib/telegram", () => ({ notifyTelegram: vi.fn(async () => {}) }));

const { db } = await import("@/lib/db");
const { runStorageCheck, R2_FREE_TIER_BYTES } = await import("@/worker/storage-check-job");
const { notifyTelegram } = await import("@/lib/telegram");

const TEST_EMAIL = "vitest-storage-check@test.local";

let userId: string;

beforeAll(async () => {
  const user = await db.user.create({
    data: { email: TEST_EMAIL, passwordHash: "not-a-real-hash", name: "Vitest" },
  });
  userId = user.id;
});

beforeEach(() => {
  delete process.env.MEDIA_WORKER_URL;
  delete process.env.MEDIA_PUSH_SECRET;
  vi.mocked(notifyTelegram).mockClear();
});

afterAll(async () => {
  vi.unstubAllGlobals();
  delete process.env.MEDIA_WORKER_URL;
  delete process.env.MEDIA_PUSH_SECRET;
  await db.user.delete({ where: { id: userId } }).catch(() => {});
});

describe("runStorageCheck (intégration DB)", () => {
  it("agrège réellement les médias READY sans planter, même sans TELEGRAM_BOT_TOKEN configuré", async () => {
    await db.mediaAsset.create({
      data: { userId, storageKey: "media/vitest/a.jpg", mimeType: "image/jpeg", sizeBytes: 1000, status: "READY" },
    });
    await db.mediaAsset.create({
      data: { userId, storageKey: "media/vitest/b.jpg", mimeType: "image/jpeg", sizeBytes: 2000, status: "UPLOADING" },
    });

    // notifyTelegram no-op silencieusement sans TELEGRAM_BOT_TOKEN (voir src/lib/telegram.ts) —
    // ce test vérifie juste l'absence d'exception, pas l'envoi réel du message.
    await expect(runStorageCheck()).resolves.toBeUndefined();
  });

  it("l'agrégation ignore les médias non-READY (contrôle de cohérence de la requête)", async () => {
    const sum = await db.mediaAsset.aggregate({
      where: { userId, status: "READY" },
      _sum: { sizeBytes: true },
    });
    // Seul le média "a.jpg" (READY, 1000o) doit compter ; "b.jpg" (UPLOADING, 2000o) doit être exclu.
    expect(sum._sum.sizeBytes).toBe(1000);
    expect(sum._sum.sizeBytes).toBeLessThan(R2_FREE_TIER_BYTES);
  });

  it("avec le Worker : l'usage RÉEL du bucket (miniatures, copies, orphelins compris) déclenche l'alerte à 70 %", async () => {
    process.env.MEDIA_WORKER_URL = "https://worker.example.dev/";
    process.env.MEDIA_PUSH_SECRET = "s3cret";
    const fetchMock = vi.fn(async () =>
      Response.json({ objects: 120, bytes: Math.round(R2_FREE_TIER_BYTES * 0.75), cursor: null })
    );
    vi.stubGlobal("fetch", fetchMock);

    await runStorageCheck();

    // La base ne connaît que 1000 octets : sans la mesure du Worker il n'y aurait AUCUNE alerte.
    expect(notifyTelegram).toHaveBeenCalledTimes(1);
    const message = String(vi.mocked(notifyTelegram).mock.calls[0][0]);
    expect(message).toContain("75 %");
    expect(message).toContain("120 objets");
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe("https://worker.example.dev/usage");
  });

  it("Worker en panne : repli sur la base ET message qui le dit (une mesure ne se dégrade pas en silence)", async () => {
    process.env.MEDIA_WORKER_URL = "https://worker.example.dev";
    process.env.MEDIA_PUSH_SECRET = "mauvais";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Unauthorized", { status: 401 })));

    await expect(runStorageCheck()).resolves.toBeUndefined();

    expect(notifyTelegram).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(notifyTelegram).mock.calls[0][0])).toContain("Mesure du stockage R2 impossible");
  });
});
