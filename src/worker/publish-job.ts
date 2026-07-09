import "server-only";
import type { JobWithMetadata } from "pg-boss";
import { db } from "@/lib/db";
import { decryptToken } from "@/lib/crypto";
import { getPublicMediaUrl } from "@/lib/storage";
import { ensureJpegVersion } from "@/lib/image-convert";
import { classifyInstagramError, classifyTikTokError, needsReauth } from "@/lib/errors";
import { recomputePostStatus } from "@/lib/post-status";
import { publishInstagramMedia, publishInstagramCarousel, getContentPublishingLimit } from "@/lib/providers/instagram";
import { publishTikTokDraftVideo, publishTikTokDraftPhoto } from "@/lib/providers/tiktok";
import { notifyTelegram } from "@/lib/telegram";

type PublishJobData = { postTargetId: string; idempotencyKey: string };
type JobResult = { id: string; status: "completed" | "failed" | "deadletter" };

async function processTarget(postTargetId: string): Promise<void> {
  const target = await db.postTarget.findUnique({
    where: { id: postTargetId },
    include: {
      post: { include: { postMedia: { include: { mediaAsset: true } } } },
      socialAccount: true,
    },
  });

  // Idempotence : la cible a disparu ou est déjà résolue → rien à faire (règle d'ingénierie n°1).
  if (!target) return;
  if (target.status === "PUBLISHED" || target.status === "SENT_TO_INBOX") return;

  await db.postTarget.update({ where: { id: postTargetId }, data: { status: "PROCESSING" } });

  const orderedMedia = target.post.postMedia
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((pm) => pm.mediaAsset);
  if (orderedMedia.length === 0) throw new Error("Aucun média associé à ce post.");

  const accessToken = decryptToken(target.socialAccount.accessTokenEnc);
  const hashtagLine = target.post.hashtags.map((h) => `#${h}`).join(" ");
  const caption = [target.captionOverride ?? target.post.caption, hashtagLine].filter(Boolean).join("\n\n");

  if (target.platform === "INSTAGRAM") {
    const quota = await getContentPublishingLimit(target.socialAccount.platformAccountId, accessToken);
    if (quota.quotaUsage >= quota.quotaTotal) {
      throw new Error("Quota de publication Instagram atteint (2207042 / erreur 9)");
    }

    const result =
      target.contentType === "CAROUSEL"
        ? await publishInstagramCarousel(
            target.socialAccount.platformAccountId,
            accessToken,
            caption,
            await Promise.all(
              orderedMedia.map(async (media) => {
                const isVideo = media.mimeType.startsWith("video/");
                const key = isVideo ? media.storageKey : await ensureJpegVersion(media.storageKey, media.mimeType);
                return { mediaUrl: getPublicMediaUrl(key), isVideo };
              })
            )
          )
        : await (async () => {
            const media = orderedMedia[0];
            const isImage = target.contentType === "IMAGE" || (target.contentType === "STORY" && !media.mimeType.startsWith("video/"));
            const key = isImage ? await ensureJpegVersion(media.storageKey, media.mimeType) : media.storageKey;
            return publishInstagramMedia({
              igUserId: target.socialAccount.platformAccountId,
              accessToken,
              caption,
              mediaType: target.contentType === "REEL" ? "REELS" : target.contentType === "STORY" ? "STORIES" : "IMAGE",
              mediaUrl: getPublicMediaUrl(key),
              isVideo: media.mimeType.startsWith("video/"),
            });
          })();

    await db.postTarget.update({
      where: { id: postTargetId },
      data: {
        status: "PUBLISHED",
        platformPostId: result.platformPostId,
        platformPostUrl: result.platformPostUrl,
        publishedAt: new Date(),
        errorCode: null,
        errorMessage: null,
      },
    });
  } else if (target.contentType === "TIKTOK_PHOTO") {
    await publishTikTokDraftPhoto(
      accessToken,
      orderedMedia.map((m) => getPublicMediaUrl(m.storageKey))
    );
    await db.postTarget.update({
      where: { id: postTargetId },
      data: { status: "SENT_TO_INBOX", publishedAt: new Date(), errorCode: null, errorMessage: null },
    });
  } else {
    // TikTok vidéo : seul le mode brouillon (inbox) est supporté tant que l'app n'est pas auditée.
    const media = orderedMedia[0];
    await publishTikTokDraftVideo(accessToken, media.storageKey, media.sizeBytes);

    await db.postTarget.update({
      where: { id: postTargetId },
      data: { status: "SENT_TO_INBOX", publishedAt: new Date(), errorCode: null, errorMessage: null },
    });
  }

  await db.activityLog.create({
    data: {
      userId: target.post.userId,
      entityType: "PostTarget",
      entityId: postTargetId,
      action: `${target.platform.toLowerCase()}_published`,
      detail: { postId: target.postId },
    },
  });
  await recomputePostStatus(target.postId);
}

async function markFailure(
  postTargetId: string,
  idempotencyKey: string,
  isTerminal: boolean,
  code: string,
  message: string,
  rawError: string
) {
  await db.postTarget.update({
    where: { id: postTargetId },
    data: { status: isTerminal ? "FAILED" : "PROCESSING", errorCode: code, errorMessage: message },
  });
  await db.publishJob.update({
    where: { idempotencyKey },
    data: { attempt: { increment: 1 }, lastError: message, state: isTerminal ? "FAILED" : "ACTIVE" },
  }).catch(() => {}); // le PublishJob peut avoir été supprimé entre-temps (annulation) — sans conséquence.

  if (isTerminal) {
    const target = await db.postTarget.findUnique({ where: { id: postTargetId }, include: { post: true } });
    if (target) {
      await recomputePostStatus(target.postId);
      // Règle d'ingénierie n°4 : un problème de token/bannissement met le compte en pause
      // jusqu'à reconnexion manuelle — jamais de retry silencieux sur un compte cassé.
      if (needsReauth(code)) {
        await db.socialAccount.update({ where: { id: target.socialAccountId }, data: { status: "NEEDS_REAUTH" } });
      }
      await db.activityLog.create({
        data: {
          userId: target.post.userId,
          entityType: "PostTarget",
          entityId: postTargetId,
          action: `${target.platform.toLowerCase()}_publish_failed`,
          // Règle d'ingénierie §6.9 : on journalise l'erreur API BRUTE (code/subcode/fbtrace Meta),
          // indispensable pour diagnostiquer un 1er run réel ; l'UI n'affiche que `message` (FR).
          detail: { code, message, rawError, postId: target.postId },
        },
      });
    }
    await notifyTelegram(`⚠️ Publication échouée (${code})\n${message}`);
  } else {
    // Échec transitoire (retry en cours) : pas d'ActivityLog utilisateur, mais on trace côté serveur
    // pour ne pas perdre la cause des tentatives intermédiaires.
    console.error(`[publish-job] échec transitoire ${code} sur target ${postTargetId} : ${rawError}`);
  }
}

export async function handlePublishBatch(
  jobs: JobWithMetadata<PublishJobData>[]
): Promise<JobResult[]> {
  const job = jobs[0];
  const { postTargetId, idempotencyKey } = job.data;
  const isLastAttempt = job.retryCount >= job.retryLimit;

  try {
    await db.publishJob.update({ where: { idempotencyKey }, data: { state: "ACTIVE" } }).catch(() => {});
    await processTarget(postTargetId);
    await db.publishJob.update({ where: { idempotencyKey }, data: { state: "COMPLETED" } }).catch(() => {});
    return [{ id: job.id, status: "completed" }];
  } catch (err) {
    const rawError = err instanceof Error ? err.message : String(err);
    const target = await db.postTarget.findUnique({ where: { id: postTargetId } });
    const classified =
      target?.platform === "TIKTOK" ? classifyTikTokError(err) : classifyInstagramError(err);

    const isTerminal = classified.errorClass !== "transient" || isLastAttempt;
    await markFailure(postTargetId, idempotencyKey, isTerminal, classified.code, classified.message, rawError);

    return [{ id: job.id, status: isTerminal ? "deadletter" : "failed" }];
  }
}
