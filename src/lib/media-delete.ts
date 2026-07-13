import { db } from "@/lib/db";
import { deleteObject } from "@/lib/storage";
import { unschedulePost } from "@/lib/scheduler";

/**
 * Cœur testable de la suppression d'un média AVEC cascade sur les posts qui l'utilisent.
 * Séparé de la Server Action [deleteMediaAsset](actions/media.ts) pour être exerçable en test
 * sans session HTTP ni `revalidatePath` (voir scheduler.test.ts).
 *
 * `userId` est le propriétaire déjà vérifié en amont ; TOUTES les requêtes sont scopées dessus
 * (le média, et chaque post avant suppression) — pas d'IDOR possible même si l'appelant se trompe.
 *
 * Comportement (décision produit du user, 09/07/2026) : au lieu de bloquer un média utilisé, on le
 * supprime — mais on ne détruit QUE les posts pas-encore-publiés :
 *  - **SCHEDULED** → dé-programmé (annulation des jobs pg-boss via `unschedulePost`) puis supprimé ;
 *  - **DRAFT** → supprimé ;
 *  - **PUBLISHED / PARTIALLY_PUBLISHED / FAILED** → CONSERVÉS pour l'historique. La suppression du
 *    MediaAsset détache simplement le média (PostMedia `onDelete: Cascade`) sans toucher au post :
 *    `platformPostId`/`platformPostUrl`/`publishedAt` et le lien d'analytics restent intacts.
 * Le contenu déjà publié sur les plateformes n'est jamais affecté (on n'agit que sur nos données).
 * Un post multi-médias non publié (carrousel brouillon/programmé) est supprimé en entier même si on
 * ne retire qu'un seul de ses médias (il ne pourrait de toute façon plus publier sans ce média).
 */
export async function deleteMediaAssetForUser(
  userId: string,
  mediaAssetId: string
): Promise<{ error?: string }> {
  const asset = await db.mediaAsset.findUnique({
    where: { id: mediaAssetId },
    include: { postMedia: { select: { postId: true } } },
  });
  if (!asset || asset.userId !== userId) {
    return { error: "Média introuvable." };
  }

  const postIds = [...new Set(asset.postMedia.map((pm) => pm.postId))];
  for (const postId of postIds) {
    const post = await db.post.findUnique({
      where: { id: postId },
      select: { status: true, userId: true },
    });
    if (!post || post.userId !== userId) continue;
    // Posts déjà publiés / en échec : on n'y touche pas — le média sera détaché par la cascade lors
    // du delete du MediaAsset, l'historique du post est préservé.
    if (post.status !== "DRAFT" && post.status !== "SCHEDULED") continue;
    if (post.status === "SCHEDULED") {
      await unschedulePost(postId); // annule les jobs pg-boss WAITING/ACTIVE avant suppression
    }
    await db.post.delete({ where: { id: postId } });
  }

  // Base d'abord (la cascade MediaAsset→PostMedia détache les posts conservés), R2 ensuite en
  // best-effort : un objet R2 déjà absent ou une panne réseau ne doit pas laisser un média
  // « fantôme » en base. On supprime aussi la miniature (thumbnailKey), sinon elle fuiterait dans R2.
  await db.mediaAsset.delete({ where: { id: mediaAssetId } });
  for (const key of [asset.storageKey, asset.thumbnailKey]) {
    if (!key) continue;
    try {
      await deleteObject(key);
    } catch (err) {
      console.error(`[deleteMediaAssetForUser] deleteObject(${key}) a échoué (best-effort) :`, err);
    }
  }

  return {};
}

/**
 * Purge IMMÉDIATE des médias d'un post qui vient d'être PUBLIÉ, quand le propriétaire a choisi la
 * rétention « Dès la publication » (`User.mediaRetentionDays === 0`). Après publication, le fichier R2
 * n'a plus d'utilité (Instagram/TikTok/YouTube en ont chacun leur propre copie) — on le supprime tout
 * de suite plutôt que d'attendre le cron quotidien.
 *
 * Appelée depuis le worker (src/worker/publish-job.ts) après `recomputePostStatus === "PUBLISHED"`.
 * Un média n'est supprimé que si TOUS les posts qui l'utilisent sont `PUBLISHED` (un média partagé
 * avec un brouillon/programmé encore en attente est conservé). Best-effort : ne jette jamais (ne doit
 * pas faire échouer le job de publication) ; requêtes séquentielles (moteur prisma dev, cf. §15).
 * Le cron quotidien reste le filet de sécurité si cette purge échoue ou si le worker redémarre.
 */
export async function purgeMediaForPublishedPost(postId: string): Promise<void> {
  const post = await db.post.findUnique({
    where: { id: postId },
    select: {
      userId: true,
      user: { select: { mediaRetentionDays: true } },
      postMedia: { select: { mediaAssetId: true } },
    },
  });
  // Seul le mode « Dès la publication » (0) déclenche la purge immédiate ; les paliers 7/30/90 restent
  // gérés par le cron quotidien, et null (Jamais) ne purge rien.
  if (!post || post.user.mediaRetentionDays !== 0) return;

  const mediaIds = [...new Set(post.postMedia.map((pm) => pm.mediaAssetId))];
  for (const mediaId of mediaIds) {
    try {
      const media = await db.mediaAsset.findUnique({
        where: { id: mediaId },
        select: { status: true, postMedia: { select: { post: { select: { status: true } } } } },
      });
      if (!media || media.status !== "READY") continue;
      const posts = media.postMedia.map((pm) => pm.post);
      // Ne purge que si TOUS les posts partageant ce média sont publiés (aucun brouillon/programmé/échec).
      const allPublished = posts.length > 0 && posts.every((p) => p.status === "PUBLISHED");
      if (!allPublished) continue;

      const result = await deleteMediaAssetForUser(post.userId, mediaId);
      if (result.error) {
        console.warn(`[purge-immédiate] média ${mediaId} (post ${postId}) : ${result.error}`);
      } else {
        console.log(`[purge-immédiate] média ${mediaId} supprimé après publication du post ${postId}`);
      }
    } catch (err) {
      console.error(`[purge-immédiate] exception sur le média ${mediaId} (post ${postId})`, err);
    }
  }
}
