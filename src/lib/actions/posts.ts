"use server";

import * as z from "zod";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { fromZonedTime } from "date-fns-tz";
import type { Platform } from "@/generated/prisma/client";
import { verifySession } from "@/lib/dal";
import { db } from "@/lib/db";
import { schedulePost, unschedulePost, reschedulePost } from "@/lib/scheduler";
import { checkInstagramCarouselCompatibility, checkTikTokPhotoCompatibility } from "@/lib/media-validation";
import {
  computeInstagramContentType,
  computeTikTokContentType,
  computeYouTubeContentType,
} from "@/lib/content-type";

const SavePostSchema = z.object({
  postId: z.string().nullish(),
  caption: z.string().max(2200, { error: "2200 caractères maximum." }),
  hashtags: z.array(z.string()).default([]),
  mediaAssetIds: z.array(z.string()).min(1, { error: "Sélectionnez au moins un média." }),
  targetInstagram: z.boolean().default(false),
  targetInstagramStory: z.boolean().default(false),
  targetTiktok: z.boolean().default(false),
  targetYoutube: z.boolean().default(false),
  // Titre YouTube saisi (contrat partagé { title?: string }). Trimé, ≤ 100 car. ; vide/absent →
  // le worker reconstruit le repli (1re ligne de légende), jamais stocké ici.
  youtubeTitle: z
    .string()
    .trim()
    .max(100, { error: "Le titre YouTube ne peut pas dépasser 100 caractères." })
    .nullish(),
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

  if (!data.targetInstagram && !data.targetTiktok && !data.targetYoutube) {
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

  const youtubeContentType = data.targetYoutube ? computeYouTubeContentType(mediaMeta) : null;
  if (data.targetYoutube && youtubeContentType === null) {
    return { error: "YouTube Shorts : sélectionnez une seule vidéo." };
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
  const youtubeAccount = accounts.find((a) => a.platform === "YOUTUBE");
  if (data.targetInstagram && !instagramAccount) {
    return { error: "Connectez d'abord votre compte Instagram." };
  }
  if (data.targetTiktok && !tiktokAccount) {
    return { error: "Connectez d'abord votre compte TikTok." };
  }
  if (data.targetYoutube && !youtubeAccount) {
    return { error: "Connectez d'abord votre compte YouTube." };
  }

  // ANTI-DOUBLE-PUBLICATION (P1-2) : une plateforme qui possède DÉJÀ une cible publiée/inbox sur ce
  // post est « déjà servie ». On ne doit ni supprimer cette cible (perte d'historique) ni en créer une
  // nouvelle (republication) — même si la case est encore cochée. Cas atteignable : un post
  // partiellement publié repassé en brouillon (unschedulePost préserve la cible réussie). Le
  // deleteMany/createMany ci-dessous ne touche donc que les cibles pas-encore-publiées.
  const servedPlatforms = new Set<Platform>();
  if (existingPost) {
    const publishedTargets = await db.postTarget.findMany({
      where: { postId: existingPost.id, status: { in: ["PUBLISHED", "SENT_TO_INBOX"] } },
      select: { platform: true },
    });
    for (const t of publishedTargets) servedPlatforms.add(t.platform);
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

    // Ne supprime QUE les cibles pas-encore-résolues : les cibles PUBLISHED/SENT_TO_INBOX sont
    // conservées telles quelles (historique + anti-republication, cf. servedPlatforms ci-dessus).
    await tx.postTarget.deleteMany({
      where: { postId: savedPost.id, status: { notIn: ["PUBLISHED", "SENT_TO_INBOX"] } },
    });
    if (data.targetInstagram && instagramAccount && igContentType && !servedPlatforms.has("INSTAGRAM")) {
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
    if (data.targetTiktok && tiktokAccount && tiktokContentType && !servedPlatforms.has("TIKTOK")) {
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
    if (data.targetYoutube && youtubeAccount && youtubeContentType && !servedPlatforms.has("YOUTUBE")) {
      await tx.postTarget.create({
        data: {
          postId: savedPost.id,
          socialAccountId: youtubeAccount.id,
          platform: "YOUTUBE",
          contentType: youtubeContentType,
          // YouTube = publication DIRECTE (pas d'inbox), comme Instagram (CLAUDE.md §25).
          publishMode: "AUTO",
          status: "PENDING",
          // Titre explicite UNIQUEMENT s'il a été saisi (contrat partagé { title?: string }). Absent →
          // le worker reconstruit le repli (1re ligne de légende via youtubeTitleFallback) ; jamais
          // stocké ici. data.youtubeTitle est déjà trimé par zod (chaîne vide = falsy → pas de titre).
          platformOptions: data.youtubeTitle ? { title: data.youtubeTitle } : {},
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

  const post = await db.post.findUnique({ where: { id: postId } });
  if (!post || post.userId !== session.userId) return { error: "Post introuvable." };
  if (post.status !== "DRAFT") {
    return { error: "Seul un brouillon peut être publié immédiatement." };
  }

  const result = await schedulePost(postId, new Date(), timezone, undefined, { immediate: true });
  if (result.error) return result;

  revalidatePath(`/composer/${postId}`);
  revalidatePath("/calendar");
  revalidatePath("/dashboard");
  return {};
}

export async function unschedulePostAction(postId: string): Promise<void> {
  const session = await verifySession();
  const post = await db.post.findUnique({ where: { id: postId } });
  if (!post || post.userId !== session.userId) return;

  // GARDE SERVEUR (P1-2) : un post entièrement PUBLIÉ n'est jamais « repassable en brouillon » — le
  // faire remettrait ses cibles en attente et provoquerait une double publication. Le bouton est déjà
  // masqué côté UI pour PUBLISHED, mais on ne s'appuie pas dessus (défense en profondeur). Les statuts
  // PARTIALLY_PUBLISHED / FAILED / SCHEDULED restent autorisés (unschedulePost préserve les cibles
  // déjà publiées d'un post partiellement publié).
  if (post.status === "PUBLISHED") return;

  await unschedulePost(postId);
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

  const post = await db.post.findUnique({ where: { id: postId } });
  if (!post || post.userId !== session.userId) return { error: "Post introuvable." };

  // datetime-local n'inclut pas de fuseau : on interprète l'heure saisie dans le fuseau de
  // l'utilisateur (jamais celui du serveur, potentiellement UTC en production).
  const newBase = fromZonedTime(scheduledAtLocal, timezone);
  if (Number.isNaN(newBase.getTime())) return { error: "Date invalide." };

  const result = await reschedulePost(postId, newBase, timezone);
  if (result.error) return result;

  revalidatePath(`/composer/${postId}`);
  revalidatePath("/calendar");
  return {};
}
