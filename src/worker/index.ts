import "server-only";
import { getBoss, PUBLISH_QUEUE, RECONCILE_QUEUE, TOKEN_REFRESH_QUEUE, STORAGE_CHECK_QUEUE } from "@/worker/boss";
import { handlePublishBatch } from "@/worker/publish-job";
import { runReconciliation } from "@/worker/reconcile-job";
import { runTokenRefresh } from "@/worker/token-refresh-job";
import { runStorageCheck } from "@/worker/storage-check-job";

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

  console.log("[worker] pg-boss démarré (queues: publish, reconcile, token-refresh, storage-check)");
}
