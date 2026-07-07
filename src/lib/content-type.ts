// Logique pure, partagée entre le composer (client) et l'action savePostDraft (serveur) —
// aucune des deux ne peut importer l'autre ("use server" interdit d'exporter du non-async).

export type InstagramContentType = "REEL" | "IMAGE" | "STORY" | "CAROUSEL";
export type TikTokContentType = "TIKTOK_VIDEO" | "TIKTOK_PHOTO";

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
