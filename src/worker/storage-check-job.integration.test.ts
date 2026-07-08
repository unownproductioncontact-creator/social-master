// Test d'intégration léger : exerce la vraie requête Prisma `aggregate` contre la base de dev
// locale (voir CLAUDE.md §13/§16). N'implique pas pg-boss (pas de queue), contrairement à
// scheduler.test.ts — juste db.mediaAsset.aggregate(), donc pas exposé au piège de protocole
// documenté pour les jobs pg-boss fraîchement créés.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "@/lib/db";
import { runStorageCheck, R2_FREE_TIER_BYTES } from "@/worker/storage-check-job";

const TEST_EMAIL = "vitest-storage-check@test.local";

let userId: string;

beforeAll(async () => {
  const user = await db.user.create({
    data: { email: TEST_EMAIL, passwordHash: "not-a-real-hash", name: "Vitest" },
  });
  userId = user.id;
});

afterAll(async () => {
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
});
