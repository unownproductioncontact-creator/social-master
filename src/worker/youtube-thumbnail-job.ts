import "server-only";
import { db } from "@/lib/db";
import { purgeMediaForPublishedPost } from "@/lib/media-delete";
import { applyYouTubeThumbnail, type ThumbnailJobData } from "@/lib/youtube-thumbnail-service";

/**
 * Nouvel essai automatique d'une miniature YouTube (CLAUDE.md §37), 5 min après une erreur passagère.
 * Ne fait rien si l'image a été remplacée ou si la miniature n'est plus en attente. Ensuite, la purge
 * « Dès la publication » a sa chance : l'image de la miniature était protégée tant qu'elle attendait.
 */
export async function runYouTubeThumbnailRetry(data: ThumbnailJobData): Promise<void> {
  const outcome = await applyYouTubeThumbnail(data.postTargetId, { attempt: 2, expectedMediaId: data.mediaAssetId });
  console.log(`[youtube-thumbnail] nouvel essai (target ${data.postTargetId}) : ${outcome.status}`);

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
