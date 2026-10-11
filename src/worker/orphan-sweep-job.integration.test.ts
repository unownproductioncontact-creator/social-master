// Balayage mensuel R2 ↔ base (CLAUDE.md §36) : vraie base de dev locale, Worker et R2 simulés.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

const deleted: string[] = [];
let workerConfig: { url: string; secret: string } | null = null;

vi.mock("@/lib/storage", () => ({
  deleteObject: vi.fn(async (key: string) => void deleted.push(key)),
  mediaWorkerPushConfig: vi.fn(() => workerConfig),
}));
vi.mock("@/lib/telegram", () => ({ notifyTelegram: vi.fn(async () => {}) }));

const { db } = await import("@/lib/db");
const { runOrphanSweep } = await import("@/worker/orphan-sweep-job");
const { notifyTelegram } = await import("@/lib/telegram");

const TEST_EMAIL = "vitest-orphan-sweep@test.local";
const NOW = new Date("2026-11-01T07:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
let userId: string;

/** Contenu simulé du bucket (une page) ; `uploaded` = âge en jours avant NOW. */
function stubBucket(objects: Array<{ key: string; ageDays: number; size?: number }>) {
  const keys = objects.map((o) => ({
    key: o.key,
    size: o.size ?? 1000,
    uploaded: new Date(NOW.getTime() - o.ageDays * DAY).toISOString(),
  }));
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ objects: keys.length, bytes: keys.reduce((s, k) => s + k.size, 0), cursor: null, keys }))
  );
}

beforeAll(async () => {
  await db.user.deleteMany({ where: { email: TEST_EMAIL } });
  const user = await db.user.create({ data: { email: TEST_EMAIL, passwordHash: "x", name: "Vitest sweep" } });
  userId = user.id;
});

beforeEach(() => {
  deleted.length = 0;
  workerConfig = { url: "https://worker.example.dev", secret: "s" };
  vi.mocked(notifyTelegram).mockClear();
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await db.user.deleteMany({ where: { email: TEST_EMAIL } });
});

async function seedAssets() {
  await db.mediaAsset.create({
    data: { userId, storageKey: "media/sweep/a.mp4", thumbnailKey: "media/sweep/a.mp4.thumb.jpg", mimeType: "video/mp4", sizeBytes: 10, status: "READY" },
  });
  await db.mediaAsset.create({
    data: { userId, storageKey: "media/sweep/b.png", mimeType: "image/png", sizeBytes: 10, status: "READY" },
  });
}

describe("runOrphanSweep (intégration DB)", () => {
  it("supprime les orphelins de plus de 7 j (miniatures de médias supprimés…) et rien d'autre", async () => {
    await seedAssets();
    stubBucket([
      { key: "media/sweep/a.mp4", ageDays: 90 },
      { key: "media/sweep/a.mp4.thumb.jpg", ageDays: 90 },
      { key: "media/sweep/b.png", ageDays: 90 },
      { key: "media/sweep/b.png.converted.jpg", ageDays: 90 }, // copie JPEG d'un média qui existe : gardée
      { key: "media/sweep/gone.mp4.thumb.jpg", ageDays: 90 }, // miniature d'un média supprimé : orphelin
      { key: "media/sweep/import-en-cours.mp4", ageDays: 1 }, // trop récent : peut-être un import en cours
      { key: "_selftest/x.bin", ageDays: 90 }, // hors du préfixe media/ : jamais touché
    ]);

    const report = await runOrphanSweep(NOW);

    expect(report).toMatchObject({ status: "done", deleted: 1, failed: 0, inspected: 6, tooRecent: 1 });
    expect(deleted).toEqual(["media/sweep/gone.mp4.thumb.jpg"]);
    expect(notifyTelegram).toHaveBeenCalledWith(expect.stringContaining("1 objet orphelin supprimé"));
  });

  it("garde-fou : plus de la moitié du bucket « orphelin » → rien n'est supprimé, alerte Telegram", async () => {
    stubBucket(
      Array.from({ length: 30 }, (_, i) => ({ key: `media/sweep/inconnu-${i}.mp4`, ageDays: 90 }))
    );

    const report = await runOrphanSweep(NOW);

    expect(report).toMatchObject({ status: "aborted", eligible: 30 });
    expect(deleted).toEqual([]);
    expect(notifyTelegram).toHaveBeenCalledWith(expect.stringContaining("interrompu"));
  });

  it("sans Worker configuré : balayage ignoré, aucune suppression", async () => {
    workerConfig = null;
    const report = await runOrphanSweep(NOW);
    expect(report).toEqual({ status: "skipped", reason: "Worker Cloudflare non configuré" });
    expect(deleted).toEqual([]);
  });
});
