import "server-only";
import { db } from "@/lib/db";
import { fetchYouTubeVideoSummary, type YouTubeVideoSummary } from "@/lib/providers/youtube";
import { freshYouTubeAccessToken } from "@/lib/youtube-token";
import { CONFIRM_DELAY_MS, CONFIRM_INTERVAL_MS, CONFIRM_MAX_CHECKS, confirmDecision } from "@/lib/youtube-scheduling";
import { enqueueYouTubeConfirmation, scheduledDelivery, type PublicationJobData } from "@/lib/youtube-scheduled-video";
import { afterTargetDelivered, composeCaption, markFailure } from "@/worker/publish-job";

/**
 * Vérification de la publication d'une vidéo programmée chez YouTube (CLAUDE.md §38) : 1 min après
 * l'heure prévue, puis toutes les 2 min, ~1 h au plus. Publique → la cible passe PUBLISHED avec les
 * suites habituelles (journal, statut du post, purge « Dès la publication »). Date déplacée dans
 * Studio → l'heure en base suit, nouvelle vérification à la nouvelle heure. Vidéo supprimée, ou
 * toujours privée 1 h après → échec expliqué. Ne fait rien si la cible a changé entre-temps (post
 * dé-programmé, vidéo remplacée). `final` (filet de la réconciliation) : une seule lecture, pas de suite.
 */
export async function runYouTubePublicationCheck(data: PublicationJobData, opts: { final?: boolean } = {}): Promise<void> {
  const target = await db.postTarget.findUnique({
    where: { id: data.postTargetId },
    include: { socialAccount: true, post: true },
  });
  if (!target || target.status !== "PLATFORM_SCHEDULED" || target.platformPostId !== data.videoId) return;

  let video: YouTubeVideoSummary | null | undefined;
  try {
    const token = await freshYouTubeAccessToken(target.socialAccount);
    video = await fetchYouTubeVideoSummary(token, data.videoId, AbortSignal.timeout(10_000));
  } catch (err) {
    console.error(`[youtube-publication] lecture impossible (target ${target.id}, vérification ${data.check})`, err);
    video = undefined; // inconnu : on retente plus tard, sans conclure
  }

  const now = new Date();
  const check = opts.final ? Math.max(data.check, CONFIRM_MAX_CHECKS) : data.check;
  if (video === undefined) {
    if (!opts.final && check < CONFIRM_MAX_CHECKS) {
      await enqueueYouTubeConfirmation(target.id, data.videoId, new Date(now.getTime() + CONFIRM_INTERVAL_MS), check + 1);
    }
    return;
  }

  const job = await db.publishJob.findFirst({ where: { postTargetId: target.id }, orderBy: { createdAt: "desc" } });
  switch (confirmDecision(video, check, now)) {
    case "published": {
      const publishedAt = target.scheduledAt && target.scheduledAt.getTime() <= now.getTime() ? target.scheduledAt : now;
      // Écriture conditionnelle : une seule vérification (job ou réconciliation) déroule les suites.
      const updated = await db.postTarget.updateMany({
        where: { id: target.id, status: "PLATFORM_SCHEDULED" },
        data: { status: "PUBLISHED", publishedAt, errorCode: null, errorMessage: null },
      });
      if (updated.count === 0) return;
      const delivery = await scheduledDelivery(target.id);
      await afterTargetDelivered(target, composeCaption(target), delivery ? { delivery } : {});
      return;
    }
    case "moved": {
      const plannedAt = new Date(Date.parse(video!.publishAt!));
      await db.postTarget.update({ where: { id: target.id }, data: { scheduledAt: plannedAt } });
      if (!opts.final) {
        await enqueueYouTubeConfirmation(target.id, data.videoId, new Date(plannedAt.getTime() + CONFIRM_DELAY_MS), 1);
      }
      return;
    }
    case "wait": {
      if (!opts.final) {
        await enqueueYouTubeConfirmation(target.id, data.videoId, new Date(now.getTime() + CONFIRM_INTERVAL_MS), check + 1);
      }
      return;
    }
    case "missing":
      await markFailure(
        target.id,
        job?.idempotencyKey ?? "",
        true,
        "yt_scheduled_missing",
        "La vidéo programmée n'existe plus sur YouTube (supprimée dans Studio ?) : rien n'a été publié.",
        `videos.list id=${data.videoId} : aucun résultat (vérification ${check})`
      );
      return;
    case "give_up":
      await markFailure(
        target.id,
        job?.idempotencyKey ?? "",
        true,
        "yt_scheduled_not_public",
        "YouTube n'a pas rendu la vidéo publique dans l'heure qui a suivi l'horaire prévu : elle est restée privée. Vérifiez dans YouTube Studio.",
        `videos.list id=${data.videoId} : privacyStatus=${video!.privacyStatus ?? "?"} publishAt=${video!.publishAt ?? "aucun"} (vérification ${check})`
      );
      return;
  }
}
