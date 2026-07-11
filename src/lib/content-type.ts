// Logique pure, partagée entre le composer (client) et l'action savePostDraft (serveur) —
// aucune des deux ne peut importer l'autre ("use server" interdit d'exporter du non-async).

export type InstagramContentType = "REEL" | "IMAGE" | "STORY" | "CAROUSEL";
export type TikTokContentType = "TIKTOK_VIDEO" | "TIKTOK_PHOTO";
export type YouTubeContentType = "YOUTUBE_SHORT";

/** IG : story si demandé et 1 seul média ; carrousel si 2+ ; sinon Reel/Image selon le type du média. */
export function computeInstagramContentType(
  mediaCount: number,
  isVideo: boolean,
  wantsStory: boolean
): InstagramContentType {
  if (mediaCount > 1) return "CAROUSEL";
  if (wantsStory) return "STORY";
  return isVideo ? "REEL" : "IMAGE";
}

/** TikTok : 1 vidéo seule → vidéo classique ; 1+ images sans vidéo → post photo ; toute autre combinaison non supportée. */
export function computeTikTokContentType(media: { isVideo: boolean }[]): TikTokContentType | null {
  const videoCount = media.filter((m) => m.isVideo).length;
  const photoCount = media.length - videoCount;
  if (videoCount === 1 && photoCount === 0) return "TIKTOK_VIDEO";
  if (videoCount === 0 && photoCount >= 1) return "TIKTOK_PHOTO";
  return null;
}

/**
 * YouTube (V1) : un Short exige EXACTEMENT une vidéo (pas de photo, pas de carrousel — décision
 * produit CLAUDE.md §25). Toute autre combinaison (image seule, plusieurs médias, mélange) → null.
 */
export function computeYouTubeContentType(media: { isVideo: boolean }[]): YouTubeContentType | null {
  if (media.length === 1 && media[0].isVideo) return "YOUTUBE_SHORT";
  return null;
}

// -----------------------------------------------------------------------------
// Titre YouTube — contrat PARTAGÉ entre lots (CLAUDE.md §25)
// -----------------------------------------------------------------------------

/** YouTube impose un titre non vide de 100 caractères maximum. */
export const YOUTUBE_TITLE_MAX_LENGTH = 100;

/**
 * Titre de repli quand l'utilisateur n'a PAS saisi de titre YouTube explicite : première ligne de la
 * légende, coupée à 100 caractères. Fonction PURE (aucun import serveur) — c'est le helper de contrat
 * partagé : le composer (client) l'utilise pour pré-remplir le champ « Titre YouTube », et le
 * worker/provider YouTube (serveur) l'utilise pour reconstruire le titre effectif à la publication
 * quand `PostTarget.platformOptions.title` est absent/vide (le repli n'est jamais stocké en base).
 */
export function youtubeTitleFallback(caption: string): string {
  const firstLine = caption.split(/\r?\n/, 1)[0]?.trim() ?? "";
  return firstLine.slice(0, YOUTUBE_TITLE_MAX_LENGTH);
}

/**
 * Titre YouTube EFFECTIF à publier : le titre explicite (`PostTarget.platformOptions.title`) s'il est
 * non vide (trimé, coupé à 100), sinon le repli `youtubeTitleFallback(caption)`, sinon "Short" —
 * YouTube EXIGE un titre non vide, l'appel API ne doit jamais partir avec "". Pure — importable
 * côté serveur (worker) comme côté client (composer). C'est LE helper canonique du contrat titre.
 */
export function resolveYouTubeTitle(
  explicitTitle: string | null | undefined,
  caption: string
): string {
  const trimmed = explicitTitle?.trim();
  if (trimmed) return trimmed.slice(0, YOUTUBE_TITLE_MAX_LENGTH);
  const fallback = youtubeTitleFallback(caption).trim();
  return fallback.length > 0 ? fallback : "Short";
}
