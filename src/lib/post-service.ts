import "server-only";
import * as z from "zod";
import { fromZonedTime } from "date-fns-tz";
import type { Platform } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { schedulePost, unschedulePost, reschedulePost } from "@/lib/scheduler";
import { checkInstagramCarouselCompatibility, checkTikTokPhotoCompatibility } from "@/lib/media-validation";
import { normalizeInstagramCollaborators, validateInstagramCollaborators } from "@/lib/instagram-collaborators";
import {
  computeInstagramContentType,
  computeTikTokContentType,
  computeYouTubeContentType,
} from "@/lib/content-type";

/**
 * Logique métier des posts, SCOPÉE PAR userId (règle d'ingénierie n°10) — partagée par les server
 * actions du composer (src/lib/actions/posts.ts, userId = session) et le connecteur Claude/MCP
 * (src/lib/mcp/, userId = jeton OAuth). Volontairement HORS fichier « use server » : une fonction
 * exportée d'un fichier « use server » devient appelable depuis le navigateur avec n'importe quel
 * userId. Ne fait aucun revalidatePath (à la charge de l'appelant web).
 */

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
  // Pseudos Instagram invités en collaboration (≤ 3, validés plus bas). Ignoré pour une Story (§28).
  instagramCollaborators: z.array(z.string().max(64)).max(10).nullish(),
});

export type SavePostInput = z.infer<typeof SavePostSchema>;

export type SavePostResult = { error?: string; postId?: string };

export async function saveDraftForUser(userId: string, input: SavePostInput): Promise<SavePostResult> {

  const parsed = SavePostSchema.safeParse(input);
  if (!parsed.success) {
    return { error: z.flattenError(parsed.error).fieldErrors.caption?.[0] ?? "Formulaire invalide." };
  }
  const data = parsed.data;

  if (!data.targetInstagram && !data.targetTiktok && !data.targetYoutube) {
    return { error: "Choisissez au moins une plateforme." };
  }

  const mediaAssets = await db.mediaAsset.findMany({ where: { id: { in: data.mediaAssetIds } } });
  if (mediaAssets.length !== data.mediaAssetIds.length || mediaAssets.some((m) => m.userId !== userId)) {
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
  if (data.postId && (!existingPost || existingPost.userId !== userId)) {
    return { error: "Post introuvable." };
  }
  if (existingPost && existingPost.status !== "DRAFT") {
    return { error: "Annulez d'abord la programmation avant de modifier ce post." };
  }

  const accounts = await db.socialAccount.findMany({ where: { userId: userId } });
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

  // Collaborateurs Instagram (§28) : uniquement Post/Reel/Carrousel — une Story n'en accepte pas.
  const igCollaborators =
    igContentType && igContentType !== "STORY"
      ? normalizeInstagramCollaborators(data.instagramCollaborators ?? [])
      : [];
  const collaboratorsError = validateInstagramCollaborators(igCollaborators, instagramAccount?.username);
  if (collaboratorsError) return { error: collaboratorsError };

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
            userId: userId,
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
          // Frame de couverture uniquement pertinente pour un Reel vidéo ; collaborateurs hors Story.
          platformOptions: {
            ...(igContentType === "REEL" && data.instagramCoverTimeMs != null
              ? { coverTimeMs: Math.round(data.instagramCoverTimeMs) }
              : {}),
            ...(igCollaborators.length > 0 ? { collaborators: igCollaborators } : {}),
          },
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

  return { postId: post.id };
}

export type ServiceResult = { error?: string };

/** Charge un post s'il appartient à `userId` (sinon null). */
async function ownedPost(userId: string, postId: string) {
  const post = await db.post.findUnique({ where: { id: postId } });
  return post && post.userId === userId ? post : null;
}

/**
 * Programme un brouillon à une heure murale `scheduledAtLocal` (« yyyy-MM-ddTHH:mm ») interprétée
 * dans `timezone` — jamais le fuseau du serveur (UTC en production).
 */
export async function schedulePostForUser(
  userId: string,
  postId: string,
  scheduledAtLocal: string,
  timezone: string
): Promise<ServiceResult> {
  if (!(await ownedPost(userId, postId))) return { error: "Post introuvable." };
  const scheduledAt = fromZonedTime(scheduledAtLocal, timezone);
  if (Number.isNaN(scheduledAt.getTime())) return { error: "Date invalide." };
  return schedulePost(postId, scheduledAt, timezone);
}

/** Publication immédiate d'un BROUILLON (cf. publishPostNowAction). */
export async function publishPostNowForUser(userId: string, postId: string, timezone: string): Promise<ServiceResult> {
  const post = await ownedPost(userId, postId);
  if (!post) return { error: "Post introuvable." };
  if (post.status !== "DRAFT") return { error: "Seul un brouillon peut être publié immédiatement." };
  return schedulePost(postId, new Date(), timezone, undefined, { immediate: true });
}

/**
 * Repasse un post en brouillon. GARDE (P1-2) : jamais un post entièrement PUBLIÉ (double publication) ;
 * PARTIALLY_PUBLISHED / FAILED / SCHEDULED autorisés (les cibles déjà servies sont préservées).
 */
export async function unschedulePostForUser(userId: string, postId: string): Promise<ServiceResult> {
  const post = await ownedPost(userId, postId);
  if (!post) return { error: "Post introuvable." };
  if (post.status === "PUBLISHED") return { error: "Un post déjà publié ne peut pas repasser en brouillon." };
  await unschedulePost(postId);
  return {};
}

/** Change l'horaire d'un post déjà programmé (cf. reschedulePost, décalages inter-cibles préservés). */
export async function reschedulePostForUser(
  userId: string,
  postId: string,
  scheduledAtLocal: string,
  timezone: string
): Promise<ServiceResult> {
  if (!(await ownedPost(userId, postId))) return { error: "Post introuvable." };
  const newBase = fromZonedTime(scheduledAtLocal, timezone);
  if (Number.isNaN(newBase.getTime())) return { error: "Date invalide." };
  return reschedulePost(postId, newBase, timezone);
}
