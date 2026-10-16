import "server-only";
import type { PostTargetStatus, Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { fetchYouTubeVideoDetails, listYouTubeChannelVideos, updateYouTubeVideo } from "@/lib/providers/youtube";
import { freshYouTubeAccessToken } from "@/lib/youtube-token";
import { CONFIRM_DELAY_MS } from "@/lib/youtube-scheduling";
import { enqueueYouTubeConfirmation } from "@/lib/youtube-scheduled-video";
import {
  applyUpdateResponse,
  classifyVideoEditError,
  editScopeStatus,
  normalizePatch,
  parseYouTubeVideoRef,
  planVideoUpdate,
  RECONNECT_FOR_EDIT_MESSAGE,
  validatePatch,
  type VideoChange,
  type YouTubeVideoDetails,
  type YouTubeVideoPatch,
} from "@/lib/youtube-video-edit";

/**
 * Modification d'une vidéo DÉJÀ sur YouTube (CLAUDE.md §39) : titre, description, tags, visibilité, date
 * de publication d'une vidéo programmée. Toute vidéo de la chaîne connectée — publiée par Social Master
 * ou non. Quand elle appartient à un post, la base suit (titre/visibilité dans les options de la cible,
 * horaire d'une vidéo programmée chez YouTube et sa vérification de publication).
 */

type YouTubeAccount = {
  id: string;
  platformAccountId: string;
  username: string;
  grantedScopes: string[];
  accessTokenEnc: string;
  refreshTokenEnc: string | null;
  tokenExpiresAt: Date | null;
};

type LinkedTarget = {
  id: string;
  postId: string;
  status: PostTargetStatus;
  scheduledAt: Date | null;
  platformOptions: Prisma.JsonValue;
  platformPostId: string | null;
  socialAccount: YouTubeAccount;
};

/** La vidéo visée : par post Social Master, ou par lien/identifiant (n'importe quelle vidéo de la chaîne). */
export type VideoRef = { postId?: string | null; video?: string | null };

export type EditScope = "granted" | "missing" | "unknown";

export type ReadVideoResult = {
  error?: string;
  code?: string;
  video?: YouTubeVideoDetails;
  channel?: string;
  postId?: string;
  targetStatus?: PostTargetStatus;
  editScope?: EditScope;
};

export type UpdateVideoResult = ReadVideoResult & {
  changes?: VideoChange[];
  notes?: string[];
};

type Resolved = { videoId: string; candidates: YouTubeAccount[]; target: LinkedTarget | null };

async function resolveVideo(userId: string, ref: VideoRef): Promise<{ error: string } | Resolved> {
  const fromLink = ref.video ? parseYouTubeVideoRef(ref.video) : null;
  if (ref.video && !fromLink) return { error: "Lien ou identifiant de vidéo YouTube non reconnu." };

  if (ref.postId) {
    const post = await db.post.findFirst({
      where: { id: ref.postId, userId },
      include: { postTargets: { where: { platform: "YOUTUBE" }, include: { socialAccount: true } } },
    });
    if (!post) return { error: "Post introuvable." };
    const target = post.postTargets[0];
    if (!target) return { error: "Ce post n'a pas de cible YouTube." };
    if (!target.platformPostId) {
      return {
        error:
          target.status === "FAILED"
            ? "La publication YouTube de ce post a échoué : il n'y a pas de vidéo à modifier."
            : post.status === "SCHEDULED"
              ? "La vidéo de ce post n'est pas encore chez YouTube (envoi à l'heure prévue) : rien à modifier là-bas. Pour changer son titre avant l'envoi : unschedule_post, save_draft, puis schedule_post."
              : "Ce post n'est pas encore publié sur YouTube : modifiez le brouillon (save_draft).",
      };
    }
    if (fromLink && fromLink !== target.platformPostId) {
      return { error: "post_id et video ne désignent pas la même vidéo : n'en indiquer qu'un." };
    }
    return { videoId: target.platformPostId, candidates: [target.socialAccount], target };
  }

  if (!fromLink) return { error: "Indiquez la vidéo (lien ou identifiant YouTube) ou le post_id Social Master." };
  const target = await db.postTarget.findFirst({
    where: { platform: "YOUTUBE", platformPostId: fromLink, post: { userId } },
    include: { socialAccount: true },
    orderBy: { updatedAt: "desc" },
  });
  if (target) return { videoId: fromLink, candidates: [target.socialAccount], target };
  const accounts = await db.socialAccount.findMany({
    where: { userId, platform: "YOUTUBE" },
    orderBy: { createdAt: "asc" },
  });
  if (accounts.length === 0) return { error: "Aucune chaîne YouTube connectée (page Connexions)." };
  return { videoId: fromLink, candidates: accounts, target: null };
}

type Owned = { video: YouTubeVideoDetails; account: YouTubeAccount; token: string };

/** Lit la vidéo avec le compte de la chaîne qui la possède (1 unité par compte essayé). */
async function readOwnedVideo(resolved: Resolved): Promise<{ error: string; code?: string } | Owned> {
  let foreign = false;
  for (const account of resolved.candidates) {
    let token: string;
    let video: YouTubeVideoDetails | null;
    try {
      token = await freshYouTubeAccessToken(account);
      video = await fetchYouTubeVideoDetails(token, resolved.videoId);
    } catch (err) {
      const classified = classifyVideoEditError(err);
      return { error: classified.message, code: classified.code };
    }
    if (!video) continue;
    if (video.channelId === account.platformAccountId) return { video, account, token };
    foreign = true;
  }
  if (foreign) {
    return {
      error: "Cette vidéo n'appartient pas à la chaîne YouTube connectée : Social Master ne modifie que les vidéos de votre chaîne.",
      code: "yt_edit_not_owned",
    };
  }
  return { error: "Vidéo introuvable sur YouTube (supprimée, ou privée sur une autre chaîne).", code: "yt_edit_not_found" };
}

/** Lecture d'une vidéo de la chaîne (1 unité) : tout ce qui est modifiable, et à quel post elle appartient. */
export async function getYouTubeVideoForUser(userId: string, ref: VideoRef): Promise<ReadVideoResult> {
  const resolved = await resolveVideo(userId, ref);
  if ("error" in resolved) return { error: resolved.error };
  const owned = await readOwnedVideo(resolved);
  if ("error" in owned) return owned;
  return {
    video: owned.video,
    channel: owned.account.username,
    postId: resolved.target?.postId,
    targetStatus: resolved.target?.status,
    editScope: editScopeStatus(owned.account.grantedScopes),
  };
}

/** Dernières vidéos de la chaîne (3 unités), avec le post Social Master de celles qui en ont un. */
export async function listYouTubeVideosForUser(
  userId: string,
  limit: number
): Promise<{ error?: string; videos?: Array<YouTubeVideoDetails & { postId?: string }>; channel?: string; editScope?: EditScope }> {
  const accounts = await db.socialAccount.findMany({ where: { userId, platform: "YOUTUBE" }, orderBy: { createdAt: "asc" } });
  const account = accounts.find((a) => a.status === "ACTIVE") ?? accounts[0];
  if (!account) return { error: "Aucune chaîne YouTube connectée (page Connexions)." };
  let videos: YouTubeVideoDetails[];
  try {
    videos = await listYouTubeChannelVideos(await freshYouTubeAccessToken(account), limit);
  } catch (err) {
    return { error: classifyVideoEditError(err).message };
  }
  const links = await db.postTarget.findMany({
    where: { platform: "YOUTUBE", platformPostId: { in: videos.map((v) => v.id) }, post: { userId } },
    select: { platformPostId: true, postId: true },
  });
  const postByVideo = new Map(links.map((l) => [l.platformPostId, l.postId]));
  return {
    videos: videos.map((v) => ({ ...v, postId: postByVideo.get(v.id) })),
    channel: account.username,
    editScope: editScopeStatus(account.grantedScopes),
  };
}

/** Nouvelle date d'une vidéo programmée chez YouTube : la cible, le post (s'il n'a que cette cible) et la vérification suivent. */
async function followMovedSchedule(target: LinkedTarget, userId: string, videoId: string, from: string | undefined, to: Date) {
  await db.postTarget.updateMany({
    where: { id: target.id, status: "PLATFORM_SCHEDULED", platformPostId: videoId },
    data: { scheduledAt: to },
  });
  if ((await db.postTarget.count({ where: { postId: target.postId } })) === 1) {
    await db.post.updateMany({ where: { id: target.postId, status: "SCHEDULED" }, data: { scheduledAt: to } });
  }
  // L'ancienne vérification (à l'ancienne heure) constatera « déplacée » ou « déjà faite » : sans effet.
  await enqueueYouTubeConfirmation(target.id, videoId, new Date(to.getTime() + CONFIRM_DELAY_MS), 1);
  await db.activityLog.create({
    data: {
      userId,
      entityType: "PostTarget",
      entityId: target.id,
      action: "youtube_schedule_moved",
      detail: { postId: target.postId, videoId, from: from ?? null, to: to.toISOString() },
    },
  });
}

/**
 * Modifie une vidéo de la chaîne : relecture, contrôles, videos.update des seules parties qui changent
 * (50 unités), puis la base suit si la vidéo appartient à un post. N'échoue jamais en silence : erreur
 * classée en français, rien n'est écrit en base si YouTube refuse.
 */
export async function updateYouTubeVideoForUser(userId: string, ref: VideoRef, input: YouTubeVideoPatch): Promise<UpdateVideoResult> {
  const resolved = await resolveVideo(userId, ref);
  if ("error" in resolved) return { error: resolved.error };
  const owned = await readOwnedVideo(resolved);
  if ("error" in owned) return owned;
  const { video: current, account, token } = owned;
  const target = resolved.target;
  const base = { channel: account.username, postId: target?.postId, targetStatus: target?.status };

  const scope = editScopeStatus(account.grantedScopes);
  if (scope === "missing") return { ...base, error: RECONNECT_FOR_EDIT_MESSAGE, code: "yt_edit_scope", editScope: scope };

  const patch = normalizePatch(input);
  const invalid = validatePatch(patch, current, new Date());
  if (invalid) return { ...base, error: invalid, code: "yt_edit_invalid", video: current };

  // Vidéo programmée PAR SOCIAL MASTER (§38) : seule une publication immédiate (public) ou un changement
  // d'heure garde le post cohérent ; non répertoriée / privée sans date reviendrait à annuler en douce.
  if (target?.status === "PLATFORM_SCHEDULED" && patch.privacy && patch.privacy !== "public" && patch.privacy !== current.privacyStatus) {
    return {
      ...base,
      error:
        "Cette vidéo est programmée par Social Master. Pour la publier tout de suite : visibilité « public » ; pour changer l'heure : publish_at (ou reschedule_post pour décaler toutes les plateformes) ; pour l'annuler : unschedule_post.",
      code: "yt_edit_invalid",
      video: current,
    };
  }

  const plan = planVideoUpdate(current, patch);
  if (plan.parts.length === 0) {
    return { ...base, video: current, changes: [], notes: ["Rien n'a changé : la vidéo a déjà ces valeurs."], editScope: scope };
  }

  let response: unknown;
  try {
    response = await updateYouTubeVideo(token, plan.parts, plan.body);
  } catch (err) {
    const classified = classifyVideoEditError(err);
    console.error(`[youtube-edit] modification refusée (vidéo ${current.id})`, err);
    return { ...base, error: classified.message, code: classified.code, video: current, editScope: scope };
  }
  const after = applyUpdateResponse(current, response);
  const notes: string[] = [];
  const changed = new Set(plan.changes.map((c) => c.field));

  if (target) {
    const options = { ...((target.platformOptions ?? {}) as Record<string, unknown>) };
    if (changed.has("title")) options.title = after.title;
    if (changed.has("privacy") && target.status === "PUBLISHED") {
      if (after.privacyStatus === "public") delete options.privacy;
      else options.privacy = after.privacyStatus;
    }
    if (changed.has("title") || changed.has("privacy")) {
      await db.postTarget.update({ where: { id: target.id }, data: { platformOptions: options as Prisma.InputJsonObject } });
    }
    if (target.status === "PLATFORM_SCHEDULED") {
      if (changed.has("publish_at") && patch.publishAt) {
        await followMovedSchedule(target, userId, current.id, current.publishAt, patch.publishAt);
      } else if (changed.has("privacy") && after.privacyStatus === "public") {
        // Publiée tout de suite : la vérification constate la mise en ligne et déroule les suites (§38).
        await enqueueYouTubeConfirmation(target.id, current.id, new Date(), 1);
        notes.push("Vidéo publiée tout de suite : sa programmation est remplacée.");
      }
    }
    if (changed.has("description")) {
      notes.push("La légende du post dans Social Master ne change pas (Instagram et TikTok gardent la leur).");
    }
  }
  notes.push("YouTube peut mettre quelques minutes à afficher le changement partout.");

  await db.activityLog.create({
    data: {
      userId,
      entityType: target ? "PostTarget" : "YouTubeVideo",
      entityId: target?.id ?? current.id,
      action: "youtube_video_updated",
      detail: { videoId: current.id, postId: target?.postId ?? null, parts: plan.parts, changes: plan.changes },
    },
  });
  return { ...base, video: after, changes: plan.changes, notes, editScope: scope };
}

/**
 * Reprogrammation (§39) : déplace SUR PLACE la date d'une vidéo programmée chez YouTube — même vidéo,
 * même identifiant, miniature posée dans Studio conservée. false = impossible (pas le droit de
 * modification, vidéo déjà publique ou absente, YouTube injoignable ou refus) : l'appelant garde l'ancien
 * chemin (suppression puis nouvel envoi).
 */
export async function moveScheduledYouTubeVideo(
  target: LinkedTarget & { post: { userId: string } },
  newTime: Date
): Promise<boolean> {
  const videoId = target.platformPostId;
  if (target.status !== "PLATFORM_SCHEDULED" || !videoId || editScopeStatus(target.socialAccount.grantedScopes) === "missing") {
    return false;
  }
  let current: YouTubeVideoDetails | null;
  try {
    const token = await freshYouTubeAccessToken(target.socialAccount);
    current = await fetchYouTubeVideoDetails(token, videoId, AbortSignal.timeout(10_000));
    if (!current || current.privacyStatus !== "private" || !current.publishAt) return false;
    if (validatePatch({ publishAt: newTime }, current, new Date())) return false;
    const plan = planVideoUpdate(current, { publishAt: newTime });
    if (plan.parts.length > 0) await updateYouTubeVideo(token, plan.parts, plan.body);
  } catch (err) {
    console.error(`[youtube-edit] déplacement sur place impossible (vidéo ${videoId}) : suppression puis nouvel envoi`, err);
    return false;
  }
  try {
    await followMovedSchedule(target, target.post.userId, videoId, current.publishAt, newTime);
  } catch (err) {
    // YouTube a la nouvelle date : la vérification de publication (« déplacée ») remettra la base d'aplomb.
    console.error(`[youtube-edit] vidéo ${videoId} déplacée chez YouTube, suivi local incomplet`, err);
  }
  return true;
}
