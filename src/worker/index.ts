import "server-only";
import type { Job, JobWithMetadata } from "pg-boss";
import {
  getBoss,
  PUBLISH_QUEUE,
  RECONCILE_QUEUE,
  TOKEN_REFRESH_QUEUE,
  STORAGE_CHECK_QUEUE,
  MEDIA_CLEANUP_QUEUE,
  MEDIA_IMPORT_QUEUE,
  ORPHAN_SWEEP_QUEUE,
  YOUTUBE_THUMBNAIL_QUEUE,
  YOUTUBE_PUBLICATION_QUEUE,
} from "@/worker/boss";
import { handlePublishBatch } from "@/worker/publish-job";
import { runReconciliation } from "@/worker/reconcile-job";
import { runTokenRefresh } from "@/worker/token-refresh-job";
import { runStorageCheck } from "@/worker/storage-check-job";
import { runMediaCleanup } from "@/worker/media-cleanup-job";
import { runMediaImport } from "@/worker/media-import-job";
import { runOrphanSweep } from "@/worker/orphan-sweep-job";
import { runYouTubeThumbnailRetry } from "@/worker/youtube-thumbnail-job";
import type { ThumbnailJobData } from "@/lib/youtube-thumbnail-service";
import { runYouTubePublicationCheck } from "@/worker/youtube-publication-job";
import type { PublicationJobData } from "@/lib/youtube-scheduled-video";

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

  // Balayage mensuel des objets R2 orphelins (CLAUDE.md §36) : le 1er de chaque mois à 7h UTC.
  await boss.createQueue(ORPHAN_SWEEP_QUEUE, { retryLimit: 1 });
  await boss.schedule(ORPHAN_SWEEP_QUEUE, "0 7 1 * *", {}, { tz: "UTC" });

  // Import de médias par lien (connecteur Claude, CLAUDE.md §30) : 1 nouvelle tentative sur erreur
  // réseau, délai max 30 min (gros fichiers).
  await boss.createQueue(MEDIA_IMPORT_QUEUE, { retryLimit: 1, retryDelay: 30, expireInSeconds: 1800 });

  // Nouvel essai UNIQUE d'une miniature YouTube après une erreur passagère (CLAUDE.md §37) : le job
  // est programmé 5 min plus tard par youtube-thumbnail-service ; pas de relance pg-boss en plus.
  await boss.createQueue(YOUTUBE_THUMBNAIL_QUEUE, { retryLimit: 0, expireInSeconds: 300 });

  // Vérification de la publication des vidéos programmées chez YouTube (CLAUDE.md §38) : chaque job
  // programme lui-même le suivant ; la réconciliation rattrape un job perdu.
  await boss.createQueue(YOUTUBE_PUBLICATION_QUEUE, { retryLimit: 1, retryDelay: 60, expireInSeconds: 300 });

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

  await boss.work(ORPHAN_SWEEP_QUEUE, async () => {
    await runOrphanSweep();
  });

  await boss.work(
    MEDIA_IMPORT_QUEUE,
    { batchSize: 1, includeMetadata: true },
    async ([job]: JobWithMetadata<{ mediaAssetId: string }>[]) => {
      await runMediaImport(job.data.mediaAssetId, job.retryCount >= job.retryLimit);
    }
  );

  await boss.work(
    YOUTUBE_THUMBNAIL_QUEUE,
    { batchSize: 1 },
    async ([job]: Job<ThumbnailJobData>[]) => {
      await runYouTubeThumbnailRetry(job.data);
    }
  );

  await boss.work(
    YOUTUBE_PUBLICATION_QUEUE,
    { batchSize: 1 },
    async ([job]: Job<PublicationJobData>[]) => {
      await runYouTubePublicationCheck(job.data);
    }
  );

  console.log(
    "[worker] pg-boss démarré (queues: publish, reconcile, token-refresh, storage-check, media-cleanup, orphan-sweep, media-import, youtube-thumbnail, youtube-publication)"
  );
}
