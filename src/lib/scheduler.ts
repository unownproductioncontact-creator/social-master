import "server-only";
import { randomUUID } from "node:crypto";
import type { Platform } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { getBoss, dbFromPrismaTx, PUBLISH_QUEUE } from "@/worker/boss";

type SchedulePostResult = { error?: string };

/**
 * Horaires effectifs PAR PLATEFORME (UTC). Décision produit : par défaut TikTok publie à H et
 * Instagram à H+5min, mais l'offset est désactivable (horaires identiques) ou remplaçable par des
 * horaires custom. La map est indexée par plateforme parce qu'un post a au plus une cible par
 * plateforme et que la décision produit est formulée par plateforme (pas par compte). Toute
 * plateforme absente de la map retombe sur `scheduledAt` (l'horaire de base du post).
 */
export type TargetTimes = Partial<Record<Platform, Date>>;

/**
 * Programme un post : post.status → SCHEDULED + un PublishJob + un job pg-boss PAR plateforme
 * ciblée, le tout dans UNE seule transaction Prisma (règle d'ingénierie n°2). Si la moindre étape
 * échoue, tout est annulé — jamais de post "programmé" sans job réel derrière.
 *
 * `scheduledAt` reste l'horaire de base (enregistré tel quel sur Post.scheduledAt). `targetTimes`
 * permet de décaler l'heure effective d'une ou plusieurs plateformes : chaque cible utilise
 * `targetTimes[cible.platform] ?? scheduledAt` pour son PostTarget.scheduledAt ainsi que pour le
 * runAt du PublishJob ET le startAfter du job pg-boss. Sans `targetTimes`, le comportement est
 * strictement identique à l'ancienne signature (toutes les cibles à `scheduledAt`).
 */
export async function schedulePost(
  postId: string,
  scheduledAt: Date,
  scheduledTz: string,
  targetTimes?: TargetTimes
): Promise<SchedulePostResult> {
  // La queue est créée une fois pour toutes au démarrage du worker (voir worker/index.ts).
  const boss = getBoss();

  const post = await db.post.findUnique({
    where: { id: postId },
    include: { postTargets: true, postMedia: true },
  });
  if (!post) return { error: "Post introuvable." };
  if (post.postTargets.length === 0) return { error: "Choisissez au moins une plateforme avant de programmer." };
  if (post.postMedia.length === 0) return { error: "Ajoutez un média avant de programmer." };

  // Horaire effectif de chaque cible : override par plateforme si fourni, sinon l'horaire de base.
  const effectiveTimeFor = (platform: Platform): Date => targetTimes?.[platform] ?? scheduledAt;

  // La validation « ≥ 60s dans le futur » s'applique à la cible LA PLUS TÔT : si la première
  // publication (TikTok à H, par ex.) est trop proche, on refuse tout le lot.
  const earliestTime = post.postTargets.reduce(
    (min, target) => {
      const t = effectiveTimeFor(target.platform).getTime();
      return t < min ? t : min;
    },
    Number.POSITIVE_INFINITY
  );
  if (earliestTime < Date.now() + 60_000) {
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
        const targetTime = effectiveTimeFor(target.platform);

        await tx.publishJob.create({
          data: {
            postTargetId: target.id,
            runAt: targetTime,
            idempotencyKey,
            state: "WAITING",
          },
        });

        await tx.postTarget.update({
          where: { id: target.id },
          data: { status: "PENDING", scheduledAt: targetTime },
        });

        await boss.send(
          PUBLISH_QUEUE,
          { postTargetId: target.id, idempotencyKey },
          {
            id: idempotencyKey,
            startAfter: targetTime,
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
    // On remet aussi PostTarget.scheduledAt à null : l'horaire effectif n'a de sens que tant que le
    // post est programmé (symétrique de l'écriture dans schedulePost).
    await tx.postTarget.updateMany({
      where: { postId },
      data: { status: "PENDING", scheduledAt: null, errorCode: null, errorMessage: null },
    });
    await tx.post.update({ where: { id: postId }, data: { status: "DRAFT", scheduledAt: null } });
  });
}
