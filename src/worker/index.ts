import "server-only";
import type { JobWithMetadata } from "pg-boss";
import {
  getBoss,
  PUBLISH_QUEUE,
  RECONCILE_QUEUE,
  TOKEN_REFRESH_QUEUE,
  STORAGE_CHECK_QUEUE,
  MEDIA_CLEANUP_QUEUE,
  MEDIA_IMPORT_QUEUE,
} from "@/worker/boss";
import { handlePublishBatch } from "@/worker/publish-job";
import { runReconciliation } from "@/worker/reconcile-job";
import { runTokenRefresh } from "@/worker/token-refresh-job";
import { runStorageCheck } from "@/worker/storage-check-job";
import { runMediaCleanup } from "@/worker/media-cleanup-job";
import { runMediaImport } from "@/worker/media-import-job";

let started = false;

/** Démarre le worker pg-boss in-process. Appelé une fois depuis instrumentation.ts (register()). */
export async function startWorker(): Promise<void> {
  if (started) return;
  started = true;

  const boss = getBoss();
  await boss.start();

  await boss.createQueue(PUBLISH_QUEUE, {
    retryLimit: 3,
    retryBackoff: true,
    retryDelay: 60,
    expireInSeconds: 600,
  });
  await boss.createQueue(RECONCILE_QUEUE, { retryLimit: 0 });
  await boss.schedule(RECONCILE_QUEUE, "*/5 * * * *", {}, { tz: "UTC" });

  await boss.createQueue(TOKEN_REFRESH_QUEUE, { retryLimit: 1 });
  await boss.schedule(TOKEN_REFRESH_QUEUE, "0 4 * * *", {}, { tz: "UTC" }); // tous les jours à 4h UTC

  await boss.createQueue(STORAGE_CHECK_QUEUE, { retryLimit: 1 });
  await boss.schedule(STORAGE_CHECK_QUEUE, "0 5 * * *", {}, { tz: "UTC" }); // tous les jours à 5h UTC

  await boss.createQueue(MEDIA_CLEANUP_QUEUE, { retryLimit: 1 });
  await boss.schedule(MEDIA_CLEANUP_QUEUE, "0 6 * * *", {}, { tz: "UTC" }); // tous les jours à 6h UTC

  // Import de médias par lien (connecteur Claude, CLAUDE.md §30) : 1 nouvelle tentative sur erreur
  // réseau, délai max 30 min (gros fichiers).
  await boss.createQueue(MEDIA_IMPORT_QUEUE, { retryLimit: 1, retryDelay: 30, expireInSeconds: 1800 });

  await boss.work(
    PUBLISH_QUEUE,
    { batchSize: 1, includeMetadata: true, perJobResults: true },
    handlePublishBatch
  );

  await boss.work(RECONCILE_QUEUE, async () => {
    await runReconciliation();
  });

  await boss.work(TOKEN_REFRESH_QUEUE, async () => {
    await runTokenRefresh();
  });

  await boss.work(STORAGE_CHECK_QUEUE, async () => {
    await runStorageCheck();
  });

  await boss.work(MEDIA_CLEANUP_QUEUE, async () => {
    await runMediaCleanup();
  });

  await boss.work(
    MEDIA_IMPORT_QUEUE,
    { batchSize: 1, includeMetadata: true },
    async ([job]: JobWithMetadata<{ mediaAssetId: string }>[]) => {
      await runMediaImport(job.data.mediaAssetId, job.retryCount >= job.retryLimit);
    }
  );

  console.log(
    "[worker] pg-boss démarré (queues: publish, reconcile, token-refresh, storage-check, media-cleanup, media-import)"
  );
}
