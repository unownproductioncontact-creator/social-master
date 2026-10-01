import "server-only";
import sharp from "sharp";
import { getObjectBuffer, readObjectRange } from "@/lib/storage";
import { MediaImportError } from "@/lib/media-import/errors";
import { looksLikeHtml, sniffMediaType, type ImportedMime } from "@/lib/media-import/sniff";
import { parseVideoMeta } from "@/lib/media-import/mp4-meta";

const MAX_IMAGE_BYTES = 50 * 1024 * 1024;

export type StoredMediaDescription = {
  mime: ImportedMime;
  width: number | null;
  height: number | null;
  durationSec: number | null;
};

/**
 * Décrit un objet DÉJÀ présent sur R2 (CLAUDE.md §30/§31) : type réel par ses premiers octets,
 * dimensions/durée par lectures partielles (vidéo MP4/MOV, rotation comprise) ou via sharp (image).
 * Lève MediaImportError si ce n'est pas un média accepté (ex. page HTML).
 */
export async function describeStoredMedia(storageKey: string, size: number): Promise<StoredMediaDescription> {
  const head = await readObjectRange(storageKey, 0, Math.min(511, size - 1));
  if (looksLikeHtml(head)) throw new MediaImportError("Le fichier reçu est une page web, pas un média.");
  const mime = sniffMediaType(head);
  if (!mime) throw new MediaImportError("Format non supporté : MP4, MOV, WebM, JPEG, PNG ou WebP uniquement.");

  if (mime === "video/mp4" || mime === "video/quicktime") {
    const meta = await parseVideoMeta({
      size,
      read: (offset, length) => readObjectRange(storageKey, offset, Math.min(offset + length, size) - 1),
    }).catch(() => ({ width: null, height: null, durationSec: null }));
    return { mime, ...meta };
  }
  if (mime.startsWith("image/") && size <= MAX_IMAGE_BYTES) {
    const info = await sharp(await getObjectBuffer(storageKey)).metadata().catch(() => null);
    if (info?.width && info?.height) {
      const swap = (info.orientation ?? 1) >= 5; // EXIF 5–8 : image tournée de 90°
      return { mime, width: swap ? info.height : info.width, height: swap ? info.width : info.height, durationSec: null };
    }
  }
  return { mime, width: null, height: null, durationSec: null };
}
