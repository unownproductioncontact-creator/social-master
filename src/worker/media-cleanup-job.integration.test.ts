// Test d'intégration léger : exerce la vraie requête Prisma (findMany/delete) contre la base de
// dev locale (voir CLAUDE.md §13/§16), sur le même modèle que storage-check-job.integration.test.ts.
// N'implique pas pg-boss (pas de queue), donc pas exposé au piège de protocole documenté pour les
// jobs pg-boss fraîchement créés. deleteObject() est appelé pour de vrai contre R2, mais les clés
// de test n'existent pas sur R2 — best-effort, l'erreur attendue est absorbée par le job lui-même
// (voir media-cleanup-job.ts), donc ce test n'a pas besoin de clés R2 réelles pour passer.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "@/lib/db";
import { runMediaCleanup } from "@/worker/media-cleanup-job";

const TEST_EMAIL = "vitest-media-cleanup@test.local";
const ONE_HOUR_MS = 60 * 60 * 1000;

let userId: string;
let staleAssetId: string;
let recentAssetId: string;
let staleReadyAssetId: string;

beforeAll(async () => {
  const user = await db.user.create({
    data: { email: TEST_EMAIL, passwordHash: "not-a-real-hash", name: "Vitest" },
  });
  userId = user.id;

  // Média UPLOADING vieux de 2h : doit être purgé.
  const stale = await db.mediaAsset.create({
    data: {
      userId,
      storageKey: "media/vitest-cleanup/stale.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 1000,
      status: "UPLOADING",
      createdAt: new Date(Date.now() - 2 * ONE_HOUR_MS),
    },
  });
  staleAssetId = stale.id;

  // Média UPLOADING récent (5 min) : ne doit PAS être purgé, l'upload est peut-être encore en cours.
  const recent = await db.mediaAsset.create({
    data: {
      userId,
      storageKey: "media/vitest-cleanup/recent.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 1000,
      status: "UPLOADING",
      createdAt: new Date(Date.now() - 5 * 60 * 1000),
    },
  });
  recentAssetId = recent.id;

  // Média READY vieux de 2h : ne doit JAMAIS être purgé (statut différent), même vieux.
  const staleReady = await db.mediaAsset.create({
    data: {
      userId,
      storageKey: "media/vitest-cleanup/stale-ready.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 1000,
      status: "READY",
      createdAt: new Date(Date.now() - 2 * ONE_HOUR_MS),
    },
  });
  staleReadyAssetId = staleReady.id;
});

afterAll(async () => {
  // Nettoyage : le média "stale" doit déjà avoir été supprimé par le job lui-même ; on nettoie les
  // autres + le user de test dans tous les cas (idempotent : delete d'un id déjà absent est catché).
  await db.mediaAsset.delete({ where: { id: recentAssetId } }).catch(() => {});
  await db.mediaAsset.delete({ where: { id: staleReadyAssetId } }).catch(() => {});
  await db.mediaAsset.delete({ where: { id: staleAssetId } }).catch(() => {});
  await db.user.delete({ where: { id: userId } }).catch(() => {});
});

describe("runMediaCleanup (intégration DB)", () => {
  it("purge sélectivement : supprime le UPLOADING vieux, garde le récent et le READY", async () => {
    await expect(runMediaCleanup()).resolves.toBeUndefined();

    const stale = await db.mediaAsset.findUnique({ where: { id: staleAssetId } });
    expect(stale).toBeNull();

    const recent = await db.mediaAsset.findUnique({ where: { id: recentAssetId } });
    expect(recent).not.toBeNull();
    expect(recent?.status).toBe("UPLOADING");

    const staleReady = await db.mediaAsset.findUnique({ where: { id: staleReadyAssetId } });
    expect(staleReady).not.toBeNull();
    expect(staleReady?.status).toBe("READY");
  });

  it("ne plante pas si aucun média orphelin n'est présent (deuxième exécution, file déjà purgée)", async () => {
    await expect(runMediaCleanup()).resolves.toBeUndefined();
  });
});
