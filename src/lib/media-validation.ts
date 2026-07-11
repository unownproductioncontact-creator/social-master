// Limites vérifiées le 07/07/2026 sur developers.facebook.com et developers.tiktok.com (voir CLAUDE.md §2).

export const MAX_UPLOAD_SIZE_BYTES = 4 * 1024 * 1024 * 1024; // 4 Go (plafond vidéo TikTok, le plus large des deux plateformes)

export const ACCEPTED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
export const ACCEPTED_VIDEO_TYPES = ["video/mp4", "video/quicktime", "video/webm"];

type MediaMeta = {
  mimeType: string;
  sizeBytes: number;
  durationSec?: number | null;
  width?: number | null;
  height?: number | null;
};

export type CompatibilityIssue = { level: "error" | "warning"; message: string };

export function checkInstagramReelCompatibility(meta: MediaMeta): CompatibilityIssue[] {
  const issues: CompatibilityIssue[] = [];
  if (!ACCEPTED_VIDEO_TYPES.includes(meta.mimeType)) {
    issues.push({ level: "error", message: "Format vidéo non supporté par Instagram Reels." });
  }
  if (meta.sizeBytes > 300 * 1024 * 1024) {
    issues.push({ level: "error", message: "Vidéo trop lourde pour un Reel (max 300 Mo)." });
  }
  if (meta.durationSec != null) {
    if (meta.durationSec < 3) issues.push({ level: "error", message: "Vidéo trop courte pour un Reel (min 3 s)." });
    if (meta.durationSec > 15 * 60) issues.push({ level: "error", message: "Vidéo trop longue pour un Reel (max 15 min)." });
  }
  return issues;
}

export function checkInstagramImageCompatibility(meta: MediaMeta): CompatibilityIssue[] {
  const issues: CompatibilityIssue[] = [];
  if (meta.mimeType !== "image/jpeg") {
    issues.push({ level: "warning", message: "Sera converti en JPEG au moment de la publication (Instagram n'accepte que ce format)." });
  }
  if (meta.sizeBytes > 8 * 1024 * 1024) {
    issues.push({ level: "error", message: "Image trop lourde pour Instagram (max 8 Mo)." });
  }
  if (meta.width && meta.height) {
    const ratio = meta.width / meta.height;
    if (ratio < 0.8 || ratio > 1.91) {
      issues.push({ level: "warning", message: "Ratio hors des limites Instagram (entre 4:5 et 1.91:1) — sera recadré." });
    }
  }
  return issues;
}

export function checkTikTokVideoCompatibility(meta: MediaMeta, maxDurationSec?: number): CompatibilityIssue[] {
  const issues: CompatibilityIssue[] = [];
  if (!ACCEPTED_VIDEO_TYPES.includes(meta.mimeType)) {
    issues.push({ level: "error", message: "Format vidéo non supporté par TikTok." });
  }
  if (meta.sizeBytes > MAX_UPLOAD_SIZE_BYTES) {
    issues.push({ level: "error", message: "Vidéo trop lourde pour TikTok (max 4 Go)." });
  }
  if (meta.durationSec != null && maxDurationSec != null && meta.durationSec > maxDurationSec) {
    issues.push({
      level: "error",
      message: `Vidéo trop longue pour votre compte TikTok (max ${Math.round(maxDurationSec / 60)} min).`,
    });
  }
  if (meta.width && meta.height && (meta.width < 360 || meta.height < 360)) {
    issues.push({ level: "warning", message: "Résolution en dessous du minimum recommandé par TikTok (360 px)." });
  }
  return issues;
}

/**
 * YouTube Short (V1) : YouTube accepte largement les vidéos (MIME `video/*`, jusqu'à 256 Go), donc la
 * seule ERREUR bloquante est « ce n'est pas une vidéo ». Les deux autres signaux sont de simples
 * AVERTISSEMENTS non bloquants : une vidéo > 3 min ou au format horizontal sera publiée normalement
 * mais classée comme vidéo classique plutôt que comme Short (classification automatique de YouTube,
 * aucun flag API — voir CLAUDE.md §25). Le carré (largeur == hauteur) reste un Short (≥ 1:1).
 */
export function checkYouTubeShortCompatibility(meta: MediaMeta): CompatibilityIssue[] {
  const issues: CompatibilityIssue[] = [];
  if (!meta.mimeType.startsWith("video/")) {
    issues.push({ level: "error", message: "Un Short YouTube nécessite une vidéo." });
  }
  if (meta.durationSec != null && meta.durationSec > 180) {
    issues.push({
      level: "warning",
      message: "Au-delà de 3 min, YouTube la publiera comme vidéo classique, pas comme Short.",
    });
  }
  if (meta.width != null && meta.height != null && meta.width > meta.height) {
    issues.push({ level: "warning", message: "Vidéo horizontale : ne sera pas classée Short." });
  }
  return issues;
}

export function isAcceptedUploadType(mimeType: string): boolean {
  return ACCEPTED_IMAGE_TYPES.includes(mimeType) || ACCEPTED_VIDEO_TYPES.includes(mimeType);
}

export function checkInstagramCarouselCompatibility(count: number): CompatibilityIssue[] {
  if (count < 2 || count > 10) {
    return [{ level: "error", message: "Un carrousel Instagram doit contenir entre 2 et 10 médias." }];
  }
  return [];
}

export function checkTikTokPhotoCompatibility(count: number): CompatibilityIssue[] {
  if (count < 1 || count > 35) {
    return [{ level: "error", message: "Un post photo TikTok doit contenir entre 1 et 35 images." }];
  }
  return [];
}
