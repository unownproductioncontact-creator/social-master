"use server";

import { revalidatePath } from "next/cache";
import { verifySession } from "@/lib/dal";
import { db } from "@/lib/db";
import { deleteObject } from "@/lib/storage";

export async function deleteMediaAsset(mediaAssetId: string): Promise<{ error?: string }> {
  const session = await verifySession();

  const asset = await db.mediaAsset.findUnique({
    where: { id: mediaAssetId },
    include: { postMedia: true },
  });
  if (!asset || asset.userId !== session.userId) {
    return { error: "Média introuvable." };
  }
  if (asset.postMedia.length > 0) {
    return { error: "Ce média est utilisé par au moins un post et ne peut pas être supprimé." };
  }

  await deleteObject(asset.storageKey);
  await db.mediaAsset.delete({ where: { id: mediaAssetId } });

  revalidatePath("/library");
  return {};
}
