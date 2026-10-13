import "server-only";
import { db } from "@/lib/db";
import { deleteYouTubeVideo, fetchYouTubeVideoSummary, unscheduleYouTubeVideo } from "@/lib/providers/youtube";
import { freshYouTubeAccessToken } from "@/lib/youtube-token";
import { readDelivery, type DeliveryPath } from "@/lib/delivery-path";
import { getBoss, YOUTUBE_PUBLICATION_QUEUE } from "@/worker/boss";

/**
 * Vidéos YouTube programmées chez YouTube (statut PLATFORM_SCHEDULED, CLAUDE.md §38) : vérification
 * programmée de leur publication, et annulation quand le post est dé-programmé, reprogrammé ou supprimé.
 */

export type PublicationJobData = { postTargetId: string; videoId: string; check: number };

/** Programme la vérification n° `check` de la publication d'une vidéo programmée chez YouTube. */
export async function enqueueYouTubeConfirmation(postTargetId: string, videoId: string, at: Date, check = 1): Promise<void> {
  const data: PublicationJobData = { postTargetId, videoId, check };
  await getBoss().send(YOUTUBE_PUBLICATION_QUEUE, data, { startAfter: at });
}

/** Par où est passé le fichier lors de l'envoi programmé (journal `youtube_scheduled`), pour le journal final. */
export async function scheduledDelivery(postTargetId: string): Promise<DeliveryPath | undefined> {
  const log = await db.activityLog.findFirst({
    where: { entityType: "PostTarget", entityId: postTargetId, action: "youtube_scheduled" },
    orderBy: { createdAt: "desc" },
    select: { detail: true },
  });
  return log ? (readDelivery(log.detail) ?? undefined) : undefined;
}

/**
 * Annule chez YouTube les vidéos programmées d'un post, AVANT que unschedulePost ne touche à la base :
 * si l'annulation est impossible, l'erreur remonte et rien n'est modifié (sinon la vidéo serait publiée
 * à l'heure prévue alors que le post serait repassé en brouillon).
 *  - déjà PUBLIQUE (heure passée, vérification pas encore faite) → on ne touche à rien chez YouTube ; la
 *    cible passe PUBLISHED et sera préservée comme toute cible publiée ;
 *  - encore privée → suppression (elle n'a jamais été publique) ; en cas d'échec, retrait de la date de
 *    publication (elle reste privée, jamais publiée) ; si les deux échouent → erreur ;
 *  - déjà absente → rien à faire.
 */
export async function cancelScheduledYouTubeVideos(postId: string): Promise<void> {
  const targets = await db.postTarget.findMany({
    where: { postId, platform: "YOUTUBE", status: "PLATFORM_SCHEDULED" },
    include: { socialAccount: true, post: { select: { userId: true } } },
  });
  for (const target of targets) {
    const videoId = target.platformPostId;
    if (!videoId) continue;
    let how: "deleted" | "unscheduled" | "already_gone" | "already_public";
    try {
      const token = await freshYouTubeAccessToken(target.socialAccount);
      const video = await fetchYouTubeVideoSummary(token, videoId, AbortSignal.timeout(10_000));
      if (!video) {
        how = "already_gone";
      } else if (video.privacyStatus === "public") {
        how = "already_public";
      } else {
        try {
          await deleteYouTubeVideo(token, videoId);
          how = "deleted";
        } catch (deleteError) {
          console.error(`[youtube-scheduled] suppression impossible (vidéo ${videoId}), retrait de la date`, deleteError);
          await unscheduleYouTubeVideo(token, videoId);
          how = "unscheduled";
        }
      }
    } catch (err) {
      throw new Error(
        `Impossible d'annuler la vidéo programmée chez YouTube (${err instanceof Error ? err.message : String(err)}). Rien n'a été modifié : réessayez dans quelques minutes, reconnectez YouTube si la connexion a expiré, ou supprimez la vidéo dans YouTube Studio puis relancez.`
      );
    }

    if (how === "already_public") {
      const publishedAt = target.scheduledAt && target.scheduledAt.getTime() <= Date.now() ? target.scheduledAt : new Date();
      const updated = await db.postTarget.updateMany({
        where: { id: target.id, status: "PLATFORM_SCHEDULED" },
        data: { status: "PUBLISHED", publishedAt, errorCode: null, errorMessage: null },
      });
      if (updated.count > 0) {
        const delivery = await scheduledDelivery(target.id);
        await db.activityLog.create({
          data: {
            userId: target.post.userId,
            entityType: "PostTarget",
            entityId: target.id,
            action: "youtube_published",
            detail: { postId, videoId, scheduledOnYouTube: true, ...(delivery ? { delivery } : {}) },
          },
        });
      }
      continue;
    }
    await db.activityLog.create({
      data: {
        userId: target.post.userId,
        entityType: "PostTarget",
        entityId: target.id,
        action: "youtube_scheduled_video_cancelled",
        detail: { postId, videoId, how },
      },
    });
  }
}
