// Test d'intégration : exerce les vraies requêtes Prisma contre la base de dev locale (CLAUDE.md
// §13/§16). N'implique pas pg-boss (pas de queue). R2 est simulé : on veut vérifier QUELLES clés sont
// supprimées (original, miniature, copie JPEG), pas l'appel réseau.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

const deleted: string[] = [];

vi.mock("@/lib/storage", () => ({
  deleteObject: vi.fn(async (key: string) => void deleted.push(key)),
}));
vi.mock("@/lib/telegram", () => ({ notifyTelegram: vi.fn(async () => {}) }));

const { db } = await import("@/lib/db");
const { runMediaCleanup } = await import("@/worker/media-cleanup-job");
const { notifyTelegram } = await import("@/lib/telegram");

const TEST_EMAIL = "vitest-media-cleanup@test.local";
const ONE_HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * ONE_HOUR_MS;

let userId: string;
const ids: Record<string, string> = {};
const createdPostIds: string[] = [];
/** Ce que le PREMIER passage du job a supprimé / notifié (le jeu de données est semé une seule fois). */
let firstRunDeleted: string[] = [];
let firstRunMessages: string[] = [];

async function createAsset(name: string, ageMs: number, extra: { status?: "UPLOADING" | "READY"; mimeType?: string } = {}) {
  const asset = await db.mediaAsset.create({
    data: {
      userId,
      storageKey: `media/vitest-cleanup/${name}`,
      mimeType: extra.mimeType ?? "image/png",
      sizeBytes: 1000,
      status: extra.status ?? "READY",
      createdAt: new Date(Date.now() - ageMs),
    },
  });
  ids[name] = asset.id;
  return asset;
}

beforeAll(async () => {
  await db.user.deleteMany({ where: { email: TEST_EMAIL } });
  const user = await db.user.create({ data: { email: TEST_EMAIL, passwordHash: "not-a-real-hash", name: "Vitest" } });
  userId = user.id;

  // Passe 1 — uploads jamais finalisés.
  await createAsset("stale-upload.jpg", 2 * ONE_HOUR_MS, { status: "UPLOADING", mimeType: "image/jpeg" });
  await createAsset("recent-upload.jpg", 5 * 60 * 1000, { status: "UPLOADING", mimeType: "image/jpeg" });
  await createAsset("fresh-ready.jpg", 2 * ONE_HOUR_MS, { mimeType: "image/jpeg" }); // READY récent : jamais purgé

  // Passe 3 — médias jamais utilisés.
  await createAsset("unused-old.png", 40 * DAY_MS);
  await createAsset("unused-recent.png", 10 * DAY_MS);
  await createAsset("used-by-draft.png", 90 * DAY_MS);
  const draft = await db.post.create({ data: { userId, caption: "brouillon", status: "DRAFT" } });
  createdPostIds.push(draft.id);
  await db.postMedia.create({ data: { postId: draft.id, mediaAssetId: ids["used-by-draft.png"], position: 0 } });

  deleted.length = 0;
  vi.mocked(notifyTelegram).mockClear();
  await runMediaCleanup();
  firstRunDeleted = [...deleted];
  firstRunMessages = vi.mocked(notifyTelegram).mock.calls.map((c) => String(c[0]));
});

beforeEach(() => {
  deleted.length = 0;
  vi.mocked(notifyTelegram).mockClear();
});

afterAll(async () => {
  await db.post.deleteMany({ where: { id: { in: createdPostIds } } });
  await db.user.deleteMany({ where: { email: TEST_EMAIL } }); // cascade : médias restants
});

describe("runMediaCleanup (intégration DB)", () => {
  it("passe 1 : supprime l'envoi jamais finalisé vieux de 2 h, garde celui de 5 min", async () => {
    expect(await db.mediaAsset.findUnique({ where: { id: ids["stale-upload.jpg"] } })).toBeNull();
    expect((await db.mediaAsset.findUnique({ where: { id: ids["recent-upload.jpg"] } }))?.status).toBe("UPLOADING");
  });

  it("passe 3 : un média jamais utilisé depuis plus de 30 j disparaît avec TOUTES ses clés R2", async () => {
    expect(await db.mediaAsset.findUnique({ where: { id: ids["unused-old.png"] } })).toBeNull();
    // Régression du 11/10/2026 : la copie JPEG d'Instagram n'était jamais supprimée.
    expect(firstRunDeleted).toEqual(
      expect.arrayContaining([
        "media/vitest-cleanup/unused-old.png",
        "media/vitest-cleanup/unused-old.png.thumb.jpg",
        "media/vitest-cleanup/unused-old.png.converted.jpg",
      ])
    );
  });

  it("garde un média récent, un média utilisé par un brouillon (et ce brouillon), et un READY frais", async () => {
    for (const name of ["unused-recent.png", "used-by-draft.png", "fresh-ready.jpg"]) {
      expect(await db.mediaAsset.findUnique({ where: { id: ids[name] } }), name).not.toBeNull();
    }
    expect(await db.post.findUnique({ where: { id: createdPostIds[0] } })).not.toBeNull();
    expect(firstRunDeleted.some((key) => key.includes("used-by-draft") || key.includes("unused-recent"))).toBe(false);
  });

  it("prévient sur Telegram des médias inutilisés supprimés", async () => {
    // Le job balaie TOUS les utilisateurs : d'éventuels restes d'autres essais dans la base de dev
    // s'ajoutent au compte, on vérifie donc le message plutôt que son nombre exact.
    expect(firstRunMessages.some((m) => /médias? jamais utilisés? depuis plus de 30 jours supprimés?/.test(m))).toBe(true);
  });

  it("deuxième passage : rien à faire, aucune suppression ni message", async () => {
    await expect(runMediaCleanup()).resolves.toBeUndefined();
    expect(deleted).toEqual([]);
    expect(notifyTelegram).not.toHaveBeenCalled();
  });
});
