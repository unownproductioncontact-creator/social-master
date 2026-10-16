"use server";

import * as z from "zod";
import { revalidatePath } from "next/cache";
import { verifySession } from "@/lib/dal";
import { YOUTUBE_PRIVACY_STATUSES, type YouTubePrivacyStatus } from "@/lib/youtube-options";
import { getYouTubeVideoForUser, updateYouTubeVideoForUser, type EditScope } from "@/lib/youtube-video-edit-service";

/**
 * Modifier sur YouTube la vidéo d'un post déjà publié ou programmé chez YouTube (CLAUDE.md §39) — même
 * service que l'outil update_youtube_video du connecteur. Chargement à la demande (bouton), jamais au
 * rendu de la page : l'actualisation automatique consommerait du quota YouTube.
 */

export type YouTubeVideoForm = {
  url: string;
  title: string;
  description: string;
  tags: string[];
  privacy: YouTubePrivacyStatus | "unknown";
  /** Date de publication programmée (ISO), tant que la vidéo est privée et programmée. */
  publishAt: string | null;
  /** Vidéo programmée par Social Master (§38) : seules « publier maintenant » et l'heure sont permises. */
  scheduledBySocialMaster: boolean;
  editScope: EditScope;
};

export async function loadYouTubeVideoAction(postId: string): Promise<{ error?: string; video?: YouTubeVideoForm }> {
  const session = await verifySession();
  const result = await getYouTubeVideoForUser(session.userId, { postId });
  if (result.error || !result.video) return { error: result.error ?? "Lecture impossible." };
  const v = result.video;
  return {
    video: {
      url: `https://youtu.be/${v.id}`,
      title: v.title,
      description: v.description,
      tags: v.tags,
      privacy: (YOUTUBE_PRIVACY_STATUSES as readonly string[]).includes(v.privacyStatus)
        ? (v.privacyStatus as YouTubePrivacyStatus)
        : "unknown",
      publishAt: v.publishAt ?? null,
      scheduledBySocialMaster: result.targetStatus === "PLATFORM_SCHEDULED",
      editScope: result.editScope ?? "unknown",
    },
  };
}

const UpdateSchema = z.object({
  postId: z.string().min(1),
  title: z.string().optional(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  privacy: z.enum(YOUTUBE_PRIVACY_STATUSES).optional(),
});

export async function updateYouTubeVideoAction(
  input: z.infer<typeof UpdateSchema>
): Promise<{ error?: string; changed?: string[]; notes?: string[] }> {
  const session = await verifySession();
  const parsed = UpdateSchema.safeParse(input);
  if (!parsed.success) return { error: "Formulaire invalide." };
  const { postId, title, description, tags, privacy } = parsed.data;
  const result = await updateYouTubeVideoForUser(session.userId, { postId }, { title, description, tags, privacy });
  if (result.error) return { error: result.error };
  revalidatePath(`/composer/${postId}`);
  return { changed: (result.changes ?? []).map((c) => c.field), notes: result.notes };
}
