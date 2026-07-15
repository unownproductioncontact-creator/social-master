import "server-only";
import { randomUUID } from "node:crypto";
import type { Platform } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { checkTikTokDraftCapacityAt } from "@/lib/quota";
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
  targetTimes?: TargetTimes,
  options?: { immediate?: boolean }
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

  // DÉFENSE EN PROFONDEUR (P1-2 / 1d) : on ne (re)programme QUE les cibles pas-encore-résolues. Une
  // cible déjà PUBLISHED ou SENT_TO_INBOX ne doit JAMAIS recevoir un nouveau PublishJob ni repasser en
  // PENDING (sinon double publication) — cas atteignable en reprogrammant un post partiellement publié.
  // Le worker skippe déjà ces cibles (publish-job.ts:27), mais on ne s'appuie pas dessus.
  const schedulableTargets = post.postTargets.filter(
    (t) => t.status === "PENDING" || t.status === "FAILED"
  );
  if (schedulableTargets.length === 0) {
    return { error: "Toutes les cibles de ce post sont déjà publiées — rien à programmer." };
  }

  type SchedulableTarget = (typeof schedulableTargets)[number];

  // Horaire effectif de chaque cible.
  // ⚡ BROUILLON TIKTOK = DÉPÔT IMMÉDIAT : tant que l'app TikTok n'est pas approuvée en Direct Post, une
  // cible TikTok en mode brouillon (publishMode `TIKTOK_DRAFT`) est déposée dans la boîte de réception
  // TikTok TOUT DE SUITE, même si le post est programmé pour plus tard. En mode brouillon, c'est
  // l'utilisateur qui publie lui-même depuis l'app TikTok au moment voulu → retarder le DÉPÔT du
  // brouillon n'a aucun intérêt (demande du user). Instagram/YouTube gardent leur horaire programmé.
  // Se neutralise seul dès le passage en Direct Post (le publishMode ne sera plus `TIKTOK_DRAFT`).
  // `options.immediate` (« Publier maintenant ») force EN PLUS toutes les cibles à maintenant.
  const now = new Date();
  const isImmediateTarget = (t: SchedulableTarget): boolean =>
    options?.immediate === true || (t.platform === "TIKTOK" && t.publishMode === "TIKTOK_DRAFT");
  const effectiveTimeFor = (t: SchedulableTarget): Date =>
    isImmediateTarget(t) ? now : targetTimes?.[t.platform] ?? scheduledAt;

  // La validation « ≥ 60s dans le futur » ne concerne QUE les cibles réellement PROGRAMMÉES (pas les
  // dépôts immédiats) : mesurée sur la cible programmée la plus tôt. Si toutes les cibles sont
  // immédiates (brouillon TikTok seul, ou « Publier maintenant »), aucune contrainte de futur.
  const scheduledTargets = schedulableTargets.filter((t) => !isImmediateTarget(t));
  if (scheduledTargets.length > 0) {
    const earliestScheduled = scheduledTargets.reduce(
      (min, t) => Math.min(min, effectiveTimeFor(t).getTime()),
      Number.POSITIVE_INFINITY
    );
    if (earliestScheduled < Date.now() + 60_000) {
      return { error: "La date de programmation doit être au moins 1 minute dans le futur." };
    }
  }

  // Garde-fou quota TikTok MESURÉ AUTOUR de l'horaire visé (P1-4) : un brouillon TikTok programmé à T
  // ne doit pas porter à plus de 5 le nombre de brouillons dans une fenêtre glissante de 24 h autour
  // de T (le décompte ancré sur « maintenant » était biaisé). Le post lui-même est naturellement
  // exclu : à la programmation initiale il n'a pas encore de PublishJob ; à la reprogrammation,
  // unschedulePost a supprimé son job AVANT d'arriver ici.
  const tiktokTarget = schedulableTargets.find(
    (t) => t.platform === "TIKTOK" && t.publishMode === "TIKTOK_DRAFT"
  );
  if (tiktokTarget) {
    const capacity = await checkTikTokDraftCapacityAt(
      { socialAccountId: tiktokTarget.socialAccountId },
      effectiveTimeFor(tiktokTarget) // = maintenant (dépôt immédiat) tant qu'on est en mode brouillon
    );
    if (!capacity.allowed) {
      return { error: capacity.message ?? "Plafond de brouillons TikTok atteint pour cet horaire." };
    }
  }

  try {
    await db.$transaction(async (tx) => {
      await tx.post.update({
        where: { id: postId },
        data: { status: "SCHEDULED", scheduledAt, scheduledTz },
      });

      for (const target of schedulableTargets) {
        const idempotencyKey = randomUUID();
        const targetTime = effectiveTimeFor(target);

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

/**
 * Annule les jobs pg-boss d'un post et repasse ses cibles PAS-ENCORE-PUBLIÉES en DRAFT (règle n°2 :
 * jamais de mutation, on annule + recrée).
 *
 * ⚠️ ANTI-DOUBLE-PUBLICATION (P1-2) : les cibles déjà `PUBLISHED` ou `SENT_TO_INBOX` sont PRÉSERVÉES
 * telles quelles — statut, `platformPostId`, `platformPostUrl`, `publishedAt` intacts. Sans ce filtre,
 * « repasser en brouillon pour corriger » un post partiellement publié effacerait l'historique de la
 * cible réussie ET la ferait republier à la reprogrammation (le pire bug possible, règle n°1). Seules
 * les cibles PENDING/PROCESSING/FAILED sont réinitialisées.
 */
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
    // On ne réinitialise QUE les cibles pas-encore-résolues (≠ PUBLISHED/SENT_TO_INBOX). On remet aussi
    // leur PostTarget.scheduledAt à null : l'horaire effectif n'a de sens que tant que le post est
    // programmé (symétrique de l'écriture dans schedulePost). Les cibles publiées gardent tout.
    await tx.postTarget.updateMany({
      where: { postId, status: { notIn: ["PUBLISHED", "SENT_TO_INBOX"] } },
      data: { status: "PENDING", scheduledAt: null, errorCode: null, errorMessage: null },
    });
    await tx.post.update({ where: { id: postId }, data: { status: "DRAFT", scheduledAt: null } });
  });
}

/**
 * Modifie l'horaire d'un post DÉJÀ programmé en UNE action (P2-4), sans re-saisie destructive, en
 * préservant les DÉCALAGES relatifs entre cibles (ex. TikTok à H, Instagram à H+5 min restent espacés
 * de 5 min autour du nouvel horaire de base).
 *
 * Garde-fous :
 *  - refuse si le post n'est pas `SCHEDULED` ;
 *  - VALIDE la nouvelle date (future, non NaN) AVANT toute écriture : si elle est invalide/passée,
 *    on ne touche à rien et la programmation actuelle reste intacte (pas de unschedule destructif
 *    suivi d'un échec) ;
 *  - sous le capot : `unschedulePost` puis `schedulePost` avec les nouveaux horaires (même chemin
 *    transactionnel que le reste — jamais de mutation en place, règle n°2).
 */
export async function reschedulePost(
  postId: string,
  newBase: Date,
  scheduledTz: string
): Promise<SchedulePostResult> {
  if (Number.isNaN(newBase.getTime())) return { error: "Date invalide." };

  const post = await db.post.findUnique({
    where: { id: postId },
    include: { postTargets: true },
  });
  if (!post) return { error: "Post introuvable." };
  if (post.status !== "SCHEDULED") {
    return { error: "Seul un post programmé peut voir son horaire modifié." };
  }

  // Décalage de chaque cible pas-encore-publiée par rapport à l'horaire de base ACTUEL (0 si la cible
  // n'a pas d'horaire propre), reporté tel quel autour du nouvel horaire de base → écarts conservés.
  const currentBaseMs = post.scheduledAt?.getTime() ?? newBase.getTime();
  const newBaseMs = newBase.getTime();
  const targetTimes: TargetTimes = {};
  let earliest = Number.POSITIVE_INFINITY;
  for (const target of post.postTargets) {
    if (target.status === "PUBLISHED" || target.status === "SENT_TO_INBOX") continue;
    const delta = (target.scheduledAt?.getTime() ?? currentBaseMs) - currentBaseMs;
    const newTimeMs = newBaseMs + delta;
    targetTimes[target.platform] = new Date(newTimeMs);
    if (newTimeMs < earliest) earliest = newTimeMs;
  }

  // Validation AVANT tout unschedule : si elle échoue, la programmation existante reste intacte.
  if (earliest === Number.POSITIVE_INFINITY) {
    return { error: "Toutes les cibles de ce post sont déjà publiées — rien à reprogrammer." };
  }
  if (earliest < Date.now() + 60_000) {
    return { error: "La date de programmation doit être au moins 1 minute dans le futur." };
  }

  await unschedulePost(postId);
  return schedulePost(postId, newBase, scheduledTz, targetTimes);
}
