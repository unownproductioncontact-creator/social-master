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
