import "server-only";
import { db } from "@/lib/db";
import { getBoss, dbFromPrismaTx, PUBLISH_QUEUE } from "@/worker/boss";
import { notifyTelegram } from "@/lib/telegram";
import { recomputePostStatus } from "@/lib/post-status";

const STUCK_WAITING_MINUTES = 10;
const STUCK_PROCESSING_MINUTES = 15;

/**
 * Filet de sécurité (règle d'ingénierie n°3), exécuté toutes les 5 min via boss.schedule().
 *
 * 1. PublishJob en WAITING dont l'heure prévue est dépassée de 10+ min : jamais démarrés (pg-boss ne
 *    les a jamais pris en charge, ex. redémarrage pendant la fenêtre d'enfilement) → sans risque de
 *    double-publication puisqu'ils n'ont jamais été traités, on les ré-enfile.
 * 2. PostTarget bloqués en PROCESSING depuis 15+ min : le traitement a été interrompu en plein vol
 *    (crash worker). On NE réessaie JAMAIS automatiquement ici — risque de double-publication réelle
 *    si la plateforme avait déjà accepté le contenu — on marque en échec pour vérification manuelle.
 */
export async function runReconciliation(): Promise<void> {
  const boss = getBoss();
  const waitingCutoff = new Date(Date.now() - STUCK_WAITING_MINUTES * 60 * 1000);
  const processingCutoff = new Date(Date.now() - STUCK_PROCESSING_MINUTES * 60 * 1000);

  const stuckWaiting = await db.publishJob.findMany({
    where: { state: "WAITING", runAt: { lt: waitingCutoff } },
  });

  for (const job of stuckWaiting) {
    await db.$transaction(async (tx) => {
      await boss.send(
        PUBLISH_QUEUE,
        { postTargetId: job.postTargetId, idempotencyKey: job.idempotencyKey },
        { id: job.idempotencyKey, singletonKey: job.idempotencyKey, db: dbFromPrismaTx(tx) }
      );
    });
  }
  if (stuckWaiting.length > 0) {
    await notifyTelegram(`🔁 Réconciliation : ${stuckWaiting.length} job(s) en attente ré-enfilé(s) (jamais démarrés).`);
  }

  const stuckProcessing = await db.postTarget.findMany({
    where: { status: "PROCESSING", updatedAt: { lt: processingCutoff } },
  });

  for (const target of stuckProcessing) {
    await db.postTarget.update({
      where: { id: target.id },
      data: {
        status: "FAILED",
        errorCode: "stuck_processing",
        errorMessage: "Traitement interrompu de manière inattendue — vérifiez manuellement si la publication a eu lieu avant de reprogrammer.",
      },
    });
    await recomputePostStatus(target.postId);
  }
  if (stuckProcessing.length > 0) {
    await notifyTelegram(
      `⚠️ Réconciliation : ${stuckProcessing.length} publication(s) interrompue(s) en plein vol — vérification manuelle requise (voir Historique).`
    );
  }
}
