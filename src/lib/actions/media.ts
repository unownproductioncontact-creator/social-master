"use server";

import { revalidatePath } from "next/cache";
import { verifySession } from "@/lib/dal";
import { deleteMediaAssetForUser } from "@/lib/media-delete";

/**
 * Server Action : supprime un média (avec cascade sur les posts qui l'utilisent — voir
 * [deleteMediaAssetForUser](../media-delete.ts)). Ne fait ici qu'authentifier + revalider les vues
 * impactées ; toute la logique est dans la fonction extraite (testée dans scheduler.test.ts).
 */
export async function deleteMediaAsset(mediaAssetId: string): Promise<{ error?: string }> {
  const session = await verifySession();

  const result = await deleteMediaAssetForUser(session.userId, mediaAssetId);
  if (result.error) return result;

  revalidatePath("/library");
  revalidatePath("/calendar");
  revalidatePath("/dashboard");
  revalidatePath("/history");
  return {};
}

/**
 * Server Action : suppression groupée de médias (mode sélection de la médiathèque, constat P3-1a).
 * Boucle SÉQUENTIELLE sur `deleteMediaAssetForUser` (jamais `Promise.all` — quirk moteur `prisma dev`,
 * cf. CLAUDE.md §15/§18) — même cascade sûre que la suppression unitaire. Retourne un décompte et la
 * liste des messages d'erreur pour un toast de résultat côté client.
 */
export async function deleteMediaAssets(
  ids: string[]
): Promise<{ deleted: number; errors: string[] }> {
  const session = await verifySession();

  const errors: string[] = [];
  let deleted = 0;

  for (const id of ids) {
    const result = await deleteMediaAssetForUser(session.userId, id);
    if (result.error) errors.push(result.error);
    else deleted++;
  }

  if (deleted > 0) {
    revalidatePath("/library");
    revalidatePath("/calendar");
    revalidatePath("/dashboard");
    revalidatePath("/history");
  }

  return { deleted, errors };
}
