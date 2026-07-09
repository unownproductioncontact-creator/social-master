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
