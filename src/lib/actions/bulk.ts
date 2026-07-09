"use server";

import * as z from "zod";
import { revalidatePath } from "next/cache";
import { verifySession } from "@/lib/dal";
import { scheduleManyPosts, type BulkItem, type ScheduleManyResult } from "@/lib/bulk-scheduler";

/**
 * Server Action FINE du LOT L4 : valide l'entrée avec zod (dates reçues en ISO string depuis le
 * client → converties en Date ici), délègue tout le métier à `scheduleManyPosts`, puis
 * `revalidatePath` des pages impactées (calendrier + dashboard) comme les actions existantes.
 * Aucune logique de programmation ici — c'est juste la couche de bord (auth + parsing + revalidate).
 */

// Une date arrive en ISO 8601 (string) depuis le client ; on la reparse ici en Date valide.
const IsoDate = z
  .string()
  .refine((s) => !Number.isNaN(new Date(s).getTime()), { error: "Date invalide." })
  .transform((s) => new Date(s));

const PlatformsSchema = z.object({
  tiktok: z.boolean().default(false),
  instagram: z.boolean().default(false),
});

const TimingSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("offset"),
    offsetSeconds: z.number().int().min(0).optional(),
  }),
  z.object({ mode: z.literal("simultaneous") }),
  z.object({
    mode: z.literal("custom"),
    customTimes: z
      .object({ tiktok: IsoDate.optional(), instagram: IsoDate.optional() })
      .optional(),
  }),
]);

const BulkItemSchema = z.object({
  mediaAssetIds: z.array(z.string()).min(1, { error: "Sélectionnez au moins un média." }),
  caption: z.string().max(2200, { error: "2200 caractères maximum." }),
  hashtags: z.array(z.string()).default([]),
  platforms: PlatformsSchema,
  baseTime: IsoDate,
  timing: TimingSchema,
});

const ScheduleManySchema = z.object({
  items: z.array(BulkItemSchema).min(1, { error: "Ajoutez au moins un post au lot." }),
});

export type ScheduleManyInput = z.input<typeof ScheduleManySchema>;

export type ScheduleManyActionResult = ScheduleManyResult | { error: string };

export async function scheduleManyPostsAction(
  input: ScheduleManyInput
): Promise<ScheduleManyActionResult> {
  const session = await verifySession();

  const parsed = ScheduleManySchema.safeParse(input);
  if (!parsed.success) {
    const flat = z.flattenError(parsed.error);
    const firstError =
      flat.formErrors[0] ??
      Object.values(flat.fieldErrors).flat().find(Boolean) ??
      "Formulaire invalide.";
    return { error: firstError };
  }

  // zod a déjà transformé les dates ISO en `Date` : la forme correspond à `BulkItem`.
  const items = parsed.data.items as BulkItem[];

  const result = await scheduleManyPosts(session.userId, items);

  // Revalide les pages qui affichent les posts programmés (mêmes cibles que les actions existantes).
  revalidatePath("/calendar");
  revalidatePath("/dashboard");

  return result;
}
