import type { YouTubePrivacyStatus } from "@/lib/youtube-options";

/**
 * Programmation NATIVE YouTube (CLAUDE.md §38, demande du user le 13/10/2026) — règles PURES, testées.
 *
 * Un post programmé envoie sa vidéo à YouTube DÈS la programmation, en privé avec `status.publishAt` =
 * l'heure prévue : la miniature est posée bien avant, et c'est YouTube qui rend le Short public à
 * l'heure dite (même pendant la veille nocturne de Render). Doc vérifiée le 13/10/2026
 * (developers.google.com/youtube/v3/docs/videos) : publishAt « can be set only if the privacy status
 * of the video is private and the video has never been published » ; une date passée = publication
 * immédiate ; sur videos.update, privacyStatus doit être renvoyé à private.
 *
 * Restent en publication directe à l'heure (ancien chemin) : « Publier maintenant », un post programmé
 * à moins de 15 min, et toute vidéo non répertoriée ou privée (publishAt ne mène qu'à « public »).
 */

/** Avance minimale, À LA PROGRAMMATION, pour confier la publication à YouTube. */
export const NATIVE_SCHEDULE_MIN_LEAD_MS = 15 * 60 * 1000;
/** Avance minimale, AU MOMENT DE L'ENVOI : en deçà (job en retard), publication directe tout de suite. */
export const NATIVE_UPLOAD_MIN_LEAD_MS = 60 * 1000;
/** Vérification de la publication : 1 min après l'heure prévue, puis toutes les 2 min, ~1 h au plus. */
export const CONFIRM_DELAY_MS = 60 * 1000;
export const CONFIRM_INTERVAL_MS = 2 * 60 * 1000;
export const CONFIRM_MAX_CHECKS = 30;

/** À la programmation : la cible YouTube part-elle tout de suite chez YouTube, programmée ? */
export function schedulesOnYouTube(input: {
  privacy: YouTubePrivacyStatus;
  publishAt: Date;
  now: Date;
  immediate: boolean;
}): boolean {
  return !input.immediate && input.privacy === "public" && input.publishAt.getTime() - input.now.getTime() >= NATIVE_SCHEDULE_MIN_LEAD_MS;
}

/**
 * Au moment de l'envoi (worker) : programmée chez YouTube (privée + publishAt) ou publication directe ?
 * Les jobs « à l'heure » (ancien chemin, ou programmés à moins de 15 min) tombent naturellement en
 * direct : ils tournent à l'heure prévue. Un envoi anticipé arrivé trop tard aussi.
 */
export function uploadAsScheduled(privacy: YouTubePrivacyStatus, publishAt: Date | null, now: Date): boolean {
  return privacy === "public" && publishAt !== null && publishAt.getTime() - now.getTime() > NATIVE_UPLOAD_MIN_LEAD_MS;
}

export type ConfirmDecision =
  /** YouTube l'a rendue publique : la cible passe PUBLISHED. */
  | "published"
  /** Encore privée, heure pas atteinte ou à peine passée : revérifier dans 2 min. */
  | "wait"
  /** Date de publication déplacée plus tard dans Studio : revérifier à la nouvelle heure (compteur remis à 1). */
  | "moved"
  /** La vidéo n'existe plus (supprimée dans Studio ?). */
  | "missing"
  /** Toujours pas publique ~1 h après l'heure prévue : abandon expliqué. */
  | "give_up";

/**
 * Que conclure de l'état lu sur YouTube à la vérification n° `check` ? `video` null = introuvable.
 * Une vidéo privée SANS date (programmation retirée dans Studio) ne sera jamais publiée : abandon au plafond.
 */
export function confirmDecision(
  video: { privacyStatus?: string; publishAt?: string } | null,
  check: number,
  now: Date
): ConfirmDecision {
  if (!video) return "missing";
  if (video.privacyStatus === "public") return "published";
  const planned = video.publishAt ? Date.parse(video.publishAt) : Number.NaN;
  if (Number.isFinite(planned) && planned > now.getTime()) return "moved";
  return check >= CONFIRM_MAX_CHECKS ? "give_up" : "wait";
}
