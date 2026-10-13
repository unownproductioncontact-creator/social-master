import "server-only";
import { db } from "@/lib/db";
import { getObjectBuffer } from "@/lib/storage";
import { prepareYouTubeThumbnail, type PreparedThumbnail } from "@/lib/thumbnail-image";
import { setYouTubeThumbnail } from "@/lib/providers/youtube";
import { freshYouTubeAccessToken } from "@/lib/youtube-token";
import {
  canSetThumbnail,
  classifyThumbnailError,
  finalFailureMessage,
  pendingRetryMessage,
  THUMBNAIL_RETRY_DELAY_MS,
  THUMBNAIL_SCOPE_MESSAGE,
  type ThumbnailFailure,
  type ThumbnailUrls,
} from "@/lib/youtube-thumbnail";
import { notifyTelegram } from "@/lib/telegram";
import { appUrl } from "@/lib/app-url";
import { getBoss, YOUTUBE_THUMBNAIL_QUEUE } from "@/worker/boss";

/**
 * Miniature personnalisée YouTube (CLAUDE.md §37) : pose l'image choisie sur la vidéo DÉJÀ publiée
 * d'une cible, tient son statut à jour (`thumbnailStatus` PENDING → SET | FAILED) et programme UN
 * nouvel essai automatique 5 min plus tard sur une erreur passagère (5xx, 429, réseau).
 *
 * Règle absolue : rien ici ne peut faire échouer la publication de la vidéo. `applyYouTubeThumbnail`
 * ne lève jamais — le worker l'appelle APRÈS avoir marqué la vidéo publiée, et une exception remontée
 * jusqu'au job de publication le ferait passer en échec puis republier (double publication).
 */

export type ThumbnailJobData = { postTargetId: string; mediaAssetId: string };

export type ThumbnailOutcome =
  | { status: "SET"; urls: ThumbnailUrls; recompressed: boolean }
  | { status: "PENDING"; message: string }
  | { status: "FAILED"; code: string; message: string }
  | { status: "SKIPPED"; reason: string };

type ApplyOptions = {
  /** 1 = premier essai (publication, set_youtube_thumbnail) ; 2 = nouvel essai automatique. */
  attempt: 1 | 2;
  /** La vidéo vient d'être envoyée (un 404 y est un délai de propagation, pas une suppression). */
  justUploaded?: boolean;
  /** Nouvel essai : l'image visée au moment de la programmation (remplacée depuis → on s'abstient). */
  expectedMediaId?: string;
};

export async function applyYouTubeThumbnail(postTargetId: string, opts: ApplyOptions): Promise<ThumbnailOutcome> {
  try {
    return await applyOnce(postTargetId, opts);
  } catch (err) {
    // Filet ultime (base injoignable…) : jamais d'exception vers l'appelant.
    console.error(`[youtube-thumbnail] exception inattendue (target ${postTargetId})`, err);
    return { status: "FAILED", code: "yt_thumb_internal", message: "Erreur interne pendant la pose de la miniature." };
  }
}

async function applyOnce(postTargetId: string, opts: ApplyOptions): Promise<ThumbnailOutcome> {
  const target = await db.postTarget.findUnique({
    where: { id: postTargetId },
    include: {
      socialAccount: true,
      coverMedia: true,
      post: { select: { id: true, userId: true, user: { select: { timezone: true } } } },
    },
  });
  if (!target || target.platform !== "YOUTUBE") return { status: "SKIPPED", reason: "cible YouTube introuvable" };
  if (opts.expectedMediaId && target.coverMediaAssetId !== opts.expectedMediaId) {
    return { status: "SKIPPED", reason: "miniature remplacée entre-temps" };
  }
  if (opts.attempt === 2 && target.thumbnailStatus !== "PENDING") {
    return { status: "SKIPPED", reason: "plus rien à réessayer" };
  }
  const media = target.coverMedia;
  if (!media) {
    // Miniature demandée puis image supprimée de la médiathèque (la relation est passée à null).
    if (target.thumbnailStatus === "PENDING") {
      return fail(target, null, { retryable: false, code: "yt_thumb_media_deleted", message: "L'image choisie comme miniature a été supprimée de la médiathèque." }, opts, "");
    }
    return { status: "SKIPPED", reason: "aucune miniature demandée" };
  }
  if (target.status !== "PUBLISHED" || !target.platformPostId) {
    return { status: "SKIPPED", reason: "vidéo pas encore publiée (miniature posée juste après la mise en ligne)" };
  }
  if (media.status !== "READY" || !media.mimeType.startsWith("image/")) {
    return fail(target, media.id, { retryable: false, code: "yt_thumb_not_image", message: "Le média choisi comme miniature n'est pas une image prête." }, opts, "");
  }
  if (!canSetThumbnail(target.socialAccount.grantedScopes)) {
    return fail(target, media.id, { retryable: false, code: "yt_thumb_scope", message: THUMBNAIL_SCOPE_MESSAGE }, opts, "");
  }

  let prepared: PreparedThumbnail;
  let urls: ThumbnailUrls;
  try {
    const accessToken = await freshYouTubeAccessToken(target.socialAccount);
    prepared = await prepareYouTubeThumbnail(await getObjectBuffer(media.storageKey), media.mimeType);
    urls = await setYouTubeThumbnail(accessToken, target.platformPostId, prepared);
  } catch (err) {
    const rawError = err instanceof Error ? err.message : String(err);
    return fail(target, media.id, classifyThumbnailError(err, { justUploaded: opts.justUploaded }), opts, rawError);
  }

  // Écriture conditionnelle : si l'image a été remplacée pendant l'envoi, on ne marque pas l'ancienne.
  await db.postTarget.updateMany({
    where: { id: target.id, coverMediaAssetId: media.id },
    data: { thumbnailStatus: "SET", thumbnailError: null, thumbnailSetAt: new Date() },
  });
  await db.activityLog.create({
    data: {
      userId: target.post.userId,
      entityType: "PostTarget",
      entityId: target.id,
      action: "youtube_thumbnail_set",
      detail: {
        postId: target.post.id,
        videoId: target.platformPostId,
        mediaId: media.id,
        attempt: opts.attempt,
        bytes: prepared.data.length,
        contentType: prepared.contentType,
        recompressed: prepared.recompressed,
        ...(prepared.quality ? { quality: prepared.quality } : {}),
        ...(prepared.width && prepared.height ? { width: prepared.width, height: prepared.height } : {}),
        urls,
      },
    },
  });
  return { status: "SET", urls, recompressed: prepared.recompressed };
}

/** Échec : nouvel essai programmé (une seule fois, erreurs passagères) ou abandon définitif. */
async function fail(
  target: { id: string; post: { id: string; userId: string; user: { timezone: string } } },
  mediaId: string | null,
  failure: ThumbnailFailure,
  opts: ApplyOptions,
  rawError: string
): Promise<ThumbnailOutcome> {
  if (failure.retryable && opts.attempt === 1 && mediaId) {
    const retryAt = new Date(Date.now() + THUMBNAIL_RETRY_DELAY_MS);
    const message = pendingRetryMessage(failure, retryAt, target.post.user.timezone);
    try {
      const data: ThumbnailJobData = { postTargetId: target.id, mediaAssetId: mediaId };
      await getBoss().send(YOUTUBE_THUMBNAIL_QUEUE, data, { startAfter: retryAt });
      await db.postTarget.updateMany({
        where: { id: target.id, coverMediaAssetId: mediaId },
        data: { thumbnailStatus: "PENDING", thumbnailError: message },
      });
      await log(target, "youtube_thumbnail_retry_scheduled", { code: failure.code, message, rawError, mediaId });
      return { status: "PENDING", message };
    } catch (err) {
      console.error(`[youtube-thumbnail] nouvel essai impossible à programmer (target ${target.id})`, err);
      // On retombe sur l'abandon ci-dessous : mieux vaut FAILED qu'un PENDING que rien ne reprendra.
    }
  }

  const message = finalFailureMessage(failure, opts.attempt === 2);
  await db.postTarget.updateMany({
    where: { id: target.id, coverMediaAssetId: mediaId },
    data: { thumbnailStatus: "FAILED", thumbnailError: message },
  });
  await log(target, "youtube_thumbnail_failed", { code: failure.code, message, rawError, mediaId });
  await notifyTelegram(
    `⚠️ Miniature YouTube non posée (la vidéo, elle, est bien publiée).\n${message}\n\n${appUrl()}/composer/${target.post.id}`
  );
  return { status: "FAILED", code: failure.code, message };
}

async function log(
  target: { id: string; post: { id: string; userId: string } },
  action: string,
  detail: Record<string, string | null>
): Promise<void> {
  // Règle §6.9 : l'erreur API BRUTE est journalisée ; get_post et Telegram n'affichent que le message FR.
  await db.activityLog.create({
    data: { userId: target.post.userId, entityType: "PostTarget", entityId: target.id, action, detail: { postId: target.post.id, ...detail } },
  });
}

/**
 * Outil `set_youtube_thumbnail` du connecteur : pose ou remplace la miniature d'une vidéo YouTube d'un
 * post de l'utilisateur. Vidéo déjà publiée → envoi immédiat (même gestion d'erreurs que la
 * publication). Pas encore publiée → l'image est retenue et sera posée juste après la mise en ligne.
 */
export async function requestYouTubeThumbnailForUser(
  userId: string,
  postId: string,
  mediaAssetId: string
): Promise<{ error?: string; outcome?: ThumbnailOutcome; videoUrl?: string | null }> {
  const post = await db.post.findFirst({
    where: { id: postId, userId },
    include: { postTargets: { where: { platform: "YOUTUBE" } } },
  });
  if (!post) return { error: "Post introuvable." };
  const target = post.postTargets[0];
  if (!target) return { error: "Ce post n'a pas de cible YouTube." };

  const media = await db.mediaAsset.findFirst({ where: { id: mediaAssetId, userId } });
  if (!media) return { error: "Média introuvable." };
  if (media.status !== "READY") return { error: "Ce média n'est pas encore prêt (suivre get_media)." };
  if (!media.mimeType.startsWith("image/")) return { error: "La miniature doit être une image (JPEG ou PNG idéalement)." };

  await db.postTarget.update({
    where: { id: target.id },
    data: { coverMediaAssetId: media.id, thumbnailStatus: "PENDING", thumbnailError: null, thumbnailSetAt: null },
  });

  if (target.status !== "PUBLISHED" || !target.platformPostId) {
    return {
      outcome: { status: "PENDING", message: "La vidéo n'est pas encore en ligne : la miniature sera posée juste après sa publication." },
      videoUrl: null,
    };
  }
  const outcome = await applyYouTubeThumbnail(target.id, { attempt: 1 });
  return { outcome, videoUrl: target.platformPostUrl };
}
