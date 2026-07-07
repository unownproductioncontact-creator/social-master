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
