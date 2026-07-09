"use server";

import { revalidatePath } from "next/cache";
import { verifySession } from "@/lib/dal";
import { db } from "@/lib/db";
import { deleteObject } from "@/lib/storage";
import { unschedulePost } from "@/lib/scheduler";

/**
 * Supprime un média. S'il est utilisé par des posts, ceux-ci sont d'abord DÉ-PROGRAMMÉS (annulation
 * des jobs pg-boss) puis SUPPRIMÉS — choix produit explicite du user : pouvoir supprimer un fichier
 * même s'il est sur un post programmé. La confirmation côté UI annonce le nombre de posts concernés.
 * Le contenu déjà publié sur les plateformes n'est évidemment pas affecté (on ne touche qu'à nos données).
 */
export async function deleteMediaAsset(mediaAssetId: string): Promise<{ error?: string }> {
  const session = await verifySession();

  const asset = await db.mediaAsset.findUnique({
    where: { id: mediaAssetId },
    include: { postMedia: { select: { postId: true } } },
  });
  if (!asset || asset.userId !== session.userId) {
    return { error: "Média introuvable." };
  }

  // Dé-programmer puis supprimer chaque post qui utilise ce média (cascade Prisma : PostTarget,
  // PublishJob, PostMedia partent avec le post). unschedulePost annule d'abord les jobs pg-boss.
  const postIds = [...new Set(asset.postMedia.map((pm) => pm.postId))];
  for (const postId of postIds) {
    const post = await db.post.findUnique({
      where: { id: postId },
      select: { status: true, userId: true },
    });
    if (!post || post.userId !== session.userId) continue;
    if (post.status !== "DRAFT") {
      await unschedulePost(postId);
    }
    await db.post.delete({ where: { id: postId } });
  }

  // Best-effort sur R2 : si l'objet est déjà absent ou que R2 hoquette, on nettoie quand même la
  // base pour ne pas laisser un média « fantôme » impossible à supprimer dans la médiathèque.
  try {
    await deleteObject(asset.storageKey);
  } catch (err) {
    console.error("[deleteMediaAsset] deleteObject a échoué, suppression en base poursuivie :", err);
  }
  await db.mediaAsset.delete({ where: { id: mediaAssetId } });

  revalidatePath("/library");
  revalidatePath("/calendar");
  revalidatePath("/dashboard");
  revalidatePath("/history");
  return {};
}
