"use server";

import * as z from "zod";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { fromZonedTime } from "date-fns-tz";
import { verifySession } from "@/lib/dal";
import { db } from "@/lib/db";
import { schedulePost, unschedulePost } from "@/lib/scheduler";
import { checkInstagramCarouselCompatibility, checkTikTokPhotoCompatibility } from "@/lib/media-validation";
import { computeInstagramContentType, computeTikTokContentType } from "@/lib/content-type";

const SavePostSchema = z.object({
  postId: z.string().nullish(),
  caption: z.string().max(2200, { error: "2200 caractères maximum." }),
  hashtags: z.array(z.string()).default([]),
  mediaAssetIds: z.array(z.string()).min(1, { error: "Sélectionnez au moins un média." }),
  targetInstagram: z.boolean().default(false),
  targetInstagramStory: z.boolean().default(false),
  targetTiktok: z.boolean().default(false),
  // Reel Instagram : frame de couverture en ms (thumb_offset). Ignoré hors REEL.
  instagramCoverTimeMs: z.number().int().min(0).nullish(),
});

export type SavePostInput = z.infer<typeof SavePostSchema>;

export type SavePostResult = { error?: string; postId?: string };

export async function savePostDraft(input: SavePostInput): Promise<SavePostResult> {
  const session = await verifySession();

  const parsed = SavePostSchema.safeParse(input);
  if (!parsed.success) {
    return { error: z.flattenError(parsed.error).fieldErrors.caption?.[0] ?? "Formulaire invalide." };
  }
  const data = parsed.data;

  if (!data.targetInstagram && !data.targetTiktok) {
    return { error: "Choisissez au moins une plateforme." };
  }

  const mediaAssets = await db.mediaAsset.findMany({ where: { id: { in: data.mediaAssetIds } } });
  if (mediaAssets.length !== data.mediaAssetIds.length || mediaAssets.some((m) => m.userId !== session.userId)) {
    return { error: "Média introuvable." };
  }
  // Conserve l'ordre choisi par l'utilisateur (findMany ne garantit pas l'ordre de la clause `in`).
  const orderedMedia = data.mediaAssetIds.map((id) => mediaAssets.find((m) => m.id === id)!);
  const mediaMeta = orderedMedia.map((m) => ({ isVideo: m.mimeType.startsWith("video/") }));

  const igContentType = data.targetInstagram
    ? computeInstagramContentType(orderedMedia.length, mediaMeta[0].isVideo, data.targetInstagramStory)
    : null;
  if (igContentType === "CAROUSEL") {
    const issues = checkInstagramCarouselCompatibility(orderedMedia.length);
    if (issues.length > 0) return { error: issues[0].message };
  }
  if (igContentType === "STORY" && orderedMedia.length > 1) {
    return { error: "Une Story ne peut contenir qu'un seul média." };
  }

  const tiktokContentType = data.targetTiktok ? computeTikTokContentType(mediaMeta) : null;
  if (data.targetTiktok && tiktokContentType === null) {
    return { error: "TikTok ne supporte pas cette combinaison de médias (une vidéo seule, ou une/plusieurs photos)." };
  }
  if (tiktokContentType === "TIKTOK_PHOTO") {
    const issues = checkTikTokPhotoCompatibility(orderedMedia.length);
    if (issues.length > 0) return { error: issues[0].message };
  }

  const existingPost = data.postId
    ? await db.post.findUnique({ where: { id: data.postId } })
    : null;
  if (data.postId && (!existingPost || existingPost.userId !== session.userId)) {
    return { error: "Post introuvable." };
  }
  if (existingPost && existingPost.status !== "DRAFT") {
    return { error: "Annulez d'abord la programmation avant de modifier ce post." };
  }

  const accounts = await db.socialAccount.findMany({ where: { userId: session.userId } });
  const instagramAccount = accounts.find((a) => a.platform === "INSTAGRAM");
  const tiktokAccount = accounts.find((a) => a.platform === "TIKTOK");
  if (data.targetInstagram && !instagramAccount) {
    return { error: "Connectez d'abord votre compte Instagram." };
  }
  if (data.targetTiktok && !tiktokAccount) {
    return { error: "Connectez d'abord votre compte TikTok." };
  }

  const post = await db.$transaction(async (tx) => {
    const savedPost = existingPost
      ? await tx.post.update({
          where: { id: existingPost.id },
          data: { caption: data.caption, hashtags: data.hashtags },
        })
      : await tx.post.create({
          data: {
            userId: session.userId,
            caption: data.caption,
            hashtags: data.hashtags,
            status: "DRAFT",
          },
        });

    await tx.postMedia.deleteMany({ where: { postId: savedPost.id } });
    await tx.postMedia.createMany({
      data: orderedMedia.map((m, position) => ({ postId: savedPost.id, mediaAssetId: m.id, position })),
    });

    await tx.postTarget.deleteMany({ where: { postId: savedPost.id } });
    if (data.targetInstagram && instagramAccount && igContentType) {
      await tx.postTarget.create({
        data: {
          postId: savedPost.id,
          socialAccountId: instagramAccount.id,
          platform: "INSTAGRAM",
          contentType: igContentType,
          publishMode: "AUTO",
          status: "PENDING",
          // Frame de couverture uniquement pertinente pour un Reel vidéo.
          platformOptions:
            igContentType === "REEL" && data.instagramCoverTimeMs != null
              ? { coverTimeMs: Math.round(data.instagramCoverTimeMs) }
              : {},
        },
      });
    }
    if (data.targetTiktok && tiktokAccount && tiktokContentType) {
      await tx.postTarget.create({
        data: {
          postId: savedPost.id,
          socialAccountId: tiktokAccount.id,
          platform: "TIKTOK",
          contentType: tiktokContentType,
          publishMode: "TIKTOK_DRAFT",
          status: "PENDING",
        },
      });
    }

    return savedPost;
  });

  revalidatePath("/composer");
  revalidatePath("/calendar");
  return { postId: post.id };
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

  const post = await db.post.findUnique({ where: { id: postId } });
  if (!post || post.userId !== session.userId) return { error: "Post introuvable." };

  // datetime-local n'inclut pas de fuseau : on interprète explicitement l'heure saisie dans le
  // fuseau de l'utilisateur (jamais le fuseau du serveur, qui peut être UTC en production).
  const scheduledAt = fromZonedTime(scheduledAtLocal, timezone);
  if (Number.isNaN(scheduledAt.getTime())) return { error: "Date invalide." };

  const result = await schedulePost(postId, scheduledAt, timezone);
  if (result.error) return result;

  revalidatePath(`/composer/${postId}`);
  revalidatePath("/calendar");
  return {};
}

export async function unschedulePostAction(postId: string): Promise<void> {
  const session = await verifySession();
  const post = await db.post.findUnique({ where: { id: postId } });
  if (!post || post.userId !== session.userId) return;

  await unschedulePost(postId);
  revalidatePath(`/composer/${postId}`);
  revalidatePath("/calendar");
}
