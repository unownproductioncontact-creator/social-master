import "server-only";
import { db } from "@/lib/db";
import { purgeMediaForPublishedPost } from "@/lib/media-delete";
import { applyYouTubeThumbnail, checkProcessingThenApply, type ThumbnailJobData } from "@/lib/youtube-thumbnail-service";

/**
 * Jobs de la file `youtube-thumbnail` (CLAUDE.md §37) : vérification de la fin du traitement de la
 * vidéo (`processing`, toutes les 2 min jusqu'à ~40 min) ou nouvel essai unique 5 min après une erreur
 * passagère (`retry`). Rien n'est fait si l'image a été remplacée ou si la miniature n'est plus en
 * attente. Ensuite, la purge « Dès la publication » a sa chance : l'image était protégée tant qu'elle attendait.
 */
export async function runYouTubeThumbnailRetry(data: ThumbnailJobData): Promise<void> {
  const outcome =
    data.kind === "processing"
      ? await checkProcessingThenApply(data.postTargetId, data.mediaAssetId, data.check ?? 1)
      : await applyYouTubeThumbnail(data.postTargetId, { attempt: 2, expectedMediaId: data.mediaAssetId });
  console.log(`[youtube-thumbnail] ${data.kind ?? "retry"} (target ${data.postTargetId}) : ${outcome.status}`);
  if (outcome.status === "PENDING") return; // encore en attente : la purge attendra l'issue

  const target = await db.postTarget.findUnique({
    where: { id: data.postTargetId },
    select: { postId: true, post: { select: { status: true } } },
  });
  if (target?.post.status === "PUBLISHED") {
    await purgeMediaForPublishedPost(target.postId).catch((err) =>
      console.error(`[youtube-thumbnail] purge après nouvel essai échouée (post ${target.postId})`, err)
    );
  }
}
