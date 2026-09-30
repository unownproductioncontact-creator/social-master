"use server";

import * as z from "zod";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { verifySession } from "@/lib/dal";
import { db } from "@/lib/db";
import { unschedulePost } from "@/lib/scheduler";
import {
  saveDraftForUser,
  schedulePostForUser,
  publishPostNowForUser,
  unschedulePostForUser,
  reschedulePostForUser,
  type SavePostInput,
  type SavePostResult,
} from "@/lib/post-service";

export type { SavePostInput, SavePostResult } from "@/lib/post-service";

export async function savePostDraft(input: SavePostInput): Promise<SavePostResult> {
  const session = await verifySession();
  const result = await saveDraftForUser(session.userId, input);
  if (result.postId) {
    revalidatePath("/composer");
    revalidatePath("/calendar");
  }
  return result;
}

export async function deletePost(postId: string): Promise<void> {
  const session = await verifySession();
  const post = await db.post.findUnique({ where: { id: postId } });
  if (!post || post.userId !== session.userId) return;

  if (post.status !== "DRAFT") {
    await unschedulePost(postId);
  }
  await db.post.delete({ where: { id: postId } });
  revalidatePath("/composer");
  revalidatePath("/calendar");
  redirect("/composer");
}

const ScheduleSchema = z.object({
  postId: z.string().min(1),
  scheduledAtLocal: z.string().min(1, { error: "Choisissez une date et une heure." }),
  timezone: z.string().default("Europe/Paris"),
});

export type ScheduleResult = { error?: string };

export async function scheduleExistingPost(input: z.infer<typeof ScheduleSchema>): Promise<ScheduleResult> {
  const session = await verifySession();
  const parsed = ScheduleSchema.safeParse(input);
  if (!parsed.success) {
    return { error: z.flattenError(parsed.error).fieldErrors.scheduledAtLocal?.[0] ?? "Formulaire invalide." };
  }
  const { postId, scheduledAtLocal, timezone } = parsed.data;

  // Heure murale interprétée dans le fuseau de l'utilisateur (jamais celui du serveur) : post-service.
  const result = await schedulePostForUser(session.userId, postId, scheduledAtLocal, timezone);
  if (result.error) return result;

  revalidatePath(`/composer/${postId}`);
  revalidatePath("/calendar");
  return {};
}

const PublishNowSchema = z.object({
  postId: z.string().min(1),
  timezone: z.string().default("Europe/Paris"),
});

/**
 * « Publier maintenant » (P — demande du user) : programme le post pour MAINTENANT, toutes cibles à
 * `now` (sans offset TikTok/IG/YT), via `schedulePost(..., { immediate: true })` qui saute la
 * contrainte « ≥ 60 s dans le futur ». Le worker pg-boss prend les jobs dans la foulée. Réservé aux
 * brouillons (un post déjà programmé/publié ne se re-publie pas ainsi — même garde que la
 * programmation). Les validations média/plateforme/quota TikTok de `schedulePost` s'appliquent.
 */
export async function publishPostNowAction(input: z.infer<typeof PublishNowSchema>): Promise<ScheduleResult> {
  const session = await verifySession();
  const parsed = PublishNowSchema.safeParse(input);
  if (!parsed.success) return { error: "Requête invalide." };
  const { postId, timezone } = parsed.data;

  const result = await publishPostNowForUser(session.userId, postId, timezone);
  if (result.error) return result;

  revalidatePath(`/composer/${postId}`);
  revalidatePath("/calendar");
  revalidatePath("/dashboard");
  return {};
}

export async function unschedulePostAction(postId: string): Promise<void> {
  const session = await verifySession();
  // GARDE SERVEUR (P1-2) dans unschedulePostForUser : un post entièrement PUBLIÉ n'est jamais
  // « repassable en brouillon » (double publication) — défense en profondeur, le bouton est déjà masqué.
  const result = await unschedulePostForUser(session.userId, postId);
  if (result.error) return;
  revalidatePath(`/composer/${postId}`);
  revalidatePath("/calendar");
}

const RescheduleSchema = z.object({
  postId: z.string().min(1),
  scheduledAtLocal: z.string().min(1, { error: "Choisissez une date et une heure." }),
  timezone: z.string().default("Europe/Paris"),
});

/**
 * « Modifier l'horaire » en UNE action (P2-4) : re-programme un post déjà SCHEDULED sans re-saisie
 * destructive. Même pattern zod/fromZonedTime que `scheduleExistingPost` ; toute la logique (refus si
 * pas SCHEDULED, validation avant écriture, préservation des décalages inter-cibles) vit dans
 * `reschedulePost`.
 */
export async function reschedulePostAction(input: z.infer<typeof RescheduleSchema>): Promise<ScheduleResult> {
  const session = await verifySession();
  const parsed = RescheduleSchema.safeParse(input);
  if (!parsed.success) {
    return { error: z.flattenError(parsed.error).fieldErrors.scheduledAtLocal?.[0] ?? "Formulaire invalide." };
  }
  const { postId, scheduledAtLocal, timezone } = parsed.data;

  const result = await reschedulePostForUser(session.userId, postId, scheduledAtLocal, timezone);
  if (result.error) return result;

  revalidatePath(`/composer/${postId}`);
  revalidatePath("/calendar");
  return {};
}
