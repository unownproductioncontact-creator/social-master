import "server-only";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { getBoss, dbFromPrismaTx, PUBLISH_QUEUE } from "@/worker/boss";

type SchedulePostResult = { error?: string };

/**
 * Programme un post : post.status → SCHEDULED + un PublishJob + un job pg-boss PAR plateforme
 * ciblée, le tout dans UNE seule transaction Prisma (règle d'ingénierie n°2). Si la moindre étape
 * échoue, tout est annulé — jamais de post "programmé" sans job réel derrière.
 */
export async function schedulePost(postId: string, scheduledAt: Date, scheduledTz: string): Promise<SchedulePostResult> {
  // La queue est créée une fois pour toutes au démarrage du worker (voir worker/index.ts).
  const boss = getBoss();

  const post = await db.post.findUnique({
    where: { id: postId },
    include: { postTargets: true, postMedia: true },
  });
  if (!post) return { error: "Post introuvable." };
  if (post.postTargets.length === 0) return { error: "Choisissez au moins une plateforme avant de programmer." };
  if (post.postMedia.length === 0) return { error: "Ajoutez un média avant de programmer." };
  if (scheduledAt.getTime() < Date.now() + 60_000) {
    return { error: "La date de programmation doit être au moins 1 minute dans le futur." };
  }

  try {
    await db.$transaction(async (tx) => {
      await tx.post.update({
        where: { id: postId },
        data: { status: "SCHEDULED", scheduledAt, scheduledTz },
      });

      for (const target of post.postTargets) {
        const idempotencyKey = randomUUID();

        await tx.publishJob.create({
          data: {
            postTargetId: target.id,
            runAt: scheduledAt,
            idempotencyKey,
            state: "WAITING",
          },
        });

        await tx.postTarget.update({ where: { id: target.id }, data: { status: "PENDING" } });

        await boss.send(
          PUBLISH_QUEUE,
          { postTargetId: target.id, idempotencyKey },
          {
            id: idempotencyKey,
            startAfter: scheduledAt,
            singletonKey: idempotencyKey,
            db: dbFromPrismaTx(tx),
          }
        );
      }
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erreur inconnue";
    return { error: `Échec de la programmation : ${message}` };
  }

  return {};
}

/** Annule tous les jobs pg-boss d'un post et repasse ses targets en DRAFT (règle n°2 : jamais de mutation, on annule + recrée). */
export async function unschedulePost(postId: string): Promise<void> {
  const boss = getBoss();

  const jobs = await db.publishJob.findMany({
    where: { postTarget: { postId } },
    include: { postTarget: true },
  });

  for (const job of jobs) {
    if (job.state === "WAITING" || job.state === "ACTIVE") {
      // Le job pg-boss a été créé avec `id: idempotencyKey` — c'est cette valeur qu'il faut annuler,
      // pas job.id (l'id Prisma interne).
      await boss.cancel(PUBLISH_QUEUE, job.idempotencyKey).catch(() => {});
    }
  }

  await db.$transaction(async (tx) => {
    await tx.publishJob.deleteMany({ where: { postTarget: { postId } } });
    await tx.postTarget.updateMany({ where: { postId }, data: { status: "PENDING", errorCode: null, errorMessage: null } });
    await tx.post.update({ where: { id: postId }, data: { status: "DRAFT", scheduledAt: null } });
  });
}
