import "server-only";
import sharp, { type Metadata } from "sharp";
import {
  THUMBNAIL_JPEG_QUALITIES,
  ThumbnailImageError,
  YOUTUBE_THUMBNAIL_MAX_BYTES,
  YOUTUBE_THUMBNAIL_TYPES,
} from "@/lib/youtube-thumbnail";

/** Cadre de repli quand même la qualité la plus basse dépasse la limite : 9:16, jamais de recadrage. */
const FALLBACK_BOX = { width: 1080, height: 1920 };

export type PreparedThumbnail = {
  data: Buffer;
  contentType: string;
  /** Le fichier envoyé n'est pas l'original (format converti et/ou recompressé). */
  recompressed: boolean;
  /** Qualité JPEG retenue si recompressé. */
  quality?: number;
  width?: number;
  height?: number;
};

/**
 * Prépare l'image d'une miniature YouTube (CLAUDE.md §37). Un JPEG ou un PNG de 2 Mo au plus part tel
 * quel. Sinon : JPEG en qualité décroissante (90 → 40) AUX MÊMES DIMENSIONS — le 9:16 1080×1920
 * d'AutoMontage est gardé, jamais recadré. Dernier recours, seulement pour une source géante : réduction
 * proportionnelle dans un cadre 1080×1920 (toujours sans recadrage). Image illisible ou impossible à
 * faire passer sous la limite → ThumbnailImageError (jamais retentée). Petits fichiers : en mémoire.
 */
export async function prepareYouTubeThumbnail(
  input: Buffer,
  mimeType: string,
  maxBytes: number = YOUTUBE_THUMBNAIL_MAX_BYTES
): Promise<PreparedThumbnail> {
  let meta: Metadata;
  try {
    meta = await sharp(input).metadata();
  } catch {
    throw new ThumbnailImageError("Image illisible : le fichier choisi comme miniature n'est pas une image valide.");
  }
  // Dimensions AFFICHÉES (une orientation EXIF de 90°/270° échange largeur et hauteur).
  const rotated = (meta.orientation ?? 1) >= 5;
  const width = rotated ? meta.height : meta.width;
  const height = rotated ? meta.width : meta.height;

  if (YOUTUBE_THUMBNAIL_TYPES.includes(mimeType) && input.length <= maxBytes) {
    return { data: input, contentType: mimeType, recompressed: false, width, height };
  }

  // `.rotate()` sans argument applique l'orientation EXIF : le JPEG produit est déjà droit.
  const attempt = async (resize: boolean) => {
    for (const quality of THUMBNAIL_JPEG_QUALITIES) {
      let pipeline = sharp(input).rotate();
      if (resize) pipeline = pipeline.resize({ ...FALLBACK_BOX, fit: "inside", withoutEnlargement: true });
      const { data, info } = await pipeline.jpeg({ quality, mozjpeg: true }).toBuffer({ resolveWithObject: true });
      if (data.length <= maxBytes) {
        return { data, contentType: "image/jpeg", recompressed: true, quality, width: info.width, height: info.height };
      }
    }
    return null;
  };

  const sameSize = await attempt(false);
  if (sameSize) return sameSize;
  const reduced = await attempt(true);
  if (reduced) return reduced;
  throw new ThumbnailImageError(
    `Image trop lourde : même recompressée, elle dépasse ${(maxBytes / 1_000_000).toFixed(0)} Mo. Envoyez une image plus légère (JPEG 1080×1920).`
  );
}
