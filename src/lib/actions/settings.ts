"use server";

import * as z from "zod";
import { revalidatePath } from "next/cache";
import { verifySession } from "@/lib/dal";
import { db } from "@/lib/db";

const UpdateProfileSchema = z.object({
  name: z.string().trim().min(1, { error: "Le nom est requis." }),
  timezone: z.string().min(1),
});

export type UpdateProfileResult = { error?: string };

export async function updateProfile(input: z.infer<typeof UpdateProfileSchema>): Promise<UpdateProfileResult> {
  const session = await verifySession();
  const parsed = UpdateProfileSchema.safeParse(input);
  if (!parsed.success) {
    return { error: z.flattenError(parsed.error).fieldErrors.name?.[0] ?? "Formulaire invalide." };
  }

  await db.user.update({
    where: { id: session.userId },
    data: { name: parsed.data.name, timezone: parsed.data.timezone },
  });

  revalidatePath("/settings");
  return {};
}

const UpdateMediaRetentionSchema = z.object({
  // null = désactivé ; les seuls paliers proposés dans l'UI sont 7 / 30 / 90 jours.
  mediaRetentionDays: z.union([z.literal(7), z.literal(30), z.literal(90), z.null()]),
});

export type UpdateMediaRetentionResult = { error?: string };

/**
 * Server Action : règle la purge automatique optionnelle des médias déjà publiés (constat P3-1c).
 * La purge elle-même tourne dans le worker (src/worker/media-cleanup-job.ts) ; ici on ne fait
 * qu'enregistrer la préférence utilisateur.
 */
export async function updateMediaRetention(
  input: z.infer<typeof UpdateMediaRetentionSchema>
): Promise<UpdateMediaRetentionResult> {
  const session = await verifySession();
  const parsed = UpdateMediaRetentionSchema.safeParse(input);
  if (!parsed.success) {
    return { error: "Valeur de rétention invalide." };
  }

  await db.user.update({
    where: { id: session.userId },
    data: { mediaRetentionDays: parsed.data.mediaRetentionDays },
  });

  revalidatePath("/settings");
  return {};
}
