import "server-only";
import { lookup } from "node:dns/promises";
import { Readable } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import sharp from "sharp";
import { db } from "@/lib/db";
import { buildStorageKey, deleteObject, getObjectBuffer, readObjectRange, uploadStream } from "@/lib/storage";
import { resolveShareLink } from "@/lib/media-import/share-link";
import { isPublicIp } from "@/lib/media-import/network-guard";
import { fileNameFromContentDisposition, finalFileName, looksLikeHtml, sniffMediaType } from "@/lib/media-import/sniff";
import { parseVideoMeta } from "@/lib/media-import/mp4-meta";

/**
 * Import d'un média depuis un lien (Google Drive, Dropbox, lien direct) — CLAUDE.md §30. Lancé par
 * l'outil MCP `import_media_from_url` via la file pg-boss `media-import` (le serveur télécharge, pas le
 * téléphone : marche depuis n'importe quelle conversation Claude et contourne les réseaux qui bloquent
 * R2). Flux de bout en bout, jamais le fichier entier en RAM (règle n°7).
 */

/** Erreur définitive à montrer telle quelle à l'utilisateur (aucune nouvelle tentative). */
export class MediaImportError extends Error {}

// `sizeBytes` est un Int Postgres (≤ 2 147 483 647) : plafond sous 2 Go.
const MAX_IMPORT_BYTES = 2_000_000_000;
const USER_STORAGE_CAP_BYTES = 9 * 1024 ** 3; // même plafond que l'upload navigateur (presign)
const MAX_REDIRECTS = 5;
const DOWNLOAD_TIMEOUT_MS = 20 * 60 * 1000;
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;

async function assertPublicHost(hostname: string): Promise<void> {
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new MediaImportError(`Adresse introuvable : ${hostname}.`);
  }
  if (addresses.length === 0 || addresses.some((a) => !isPublicIp(a.address))) {
    throw new MediaImportError("Lien refusé : il pointe vers une adresse non publique.");
  }
}

/** fetch qui suit lui-même les redirections en re-vérifiant chaque étape (https + adresse publique). */
async function safeFetch(url: string): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const parsed = new URL(current);
    if (parsed.protocol !== "https:") throw new MediaImportError("Redirection vers un lien non sécurisé refusée.");
    await assertPublicHost(parsed.hostname);
    const res = await fetch(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      headers: { "User-Agent": "SocialMaster-Import/1.0" },
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new MediaImportError("Redirection invalide.");
      await res.body?.cancel();
      current = new URL(location, current).toString();
      continue;
    }
    return res;
  }
  throw new MediaImportError("Trop de redirections.");
}

/** Lit le début du flux (au moins `min` octets) pour identifier le type réel du fichier. */
async function peek(reader: ReadableStreamDefaultReader<Uint8Array>, min: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (length < min) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    chunks.push(value);
    length += value.length;
  }
  const out = new Uint8Array(length);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

async function markFailed(mediaAssetId: string, message: string): Promise<void> {
  await db.mediaAsset.updateMany({
    where: { id: mediaAssetId, status: "UPLOADING" },
    data: { status: "FAILED", importError: message },
  });
}

/**
 * Exécute l'import. `isLastAttempt` : une erreur réseau inattendue passe en échec définitif au lieu
 * d'être relancée par pg-boss.
 */
export async function runMediaImport(mediaAssetId: string, isLastAttempt: boolean): Promise<void> {
  const asset = await db.mediaAsset.findUnique({ where: { id: mediaAssetId } });
  if (!asset || asset.status !== "UPLOADING" || !asset.importUrl) return;

  let uploadedKey: string | null = null;
  try {
    const link = resolveShareLink(asset.importUrl);
    if (!link.ok) throw new MediaImportError(link.error);

    const res = await safeFetch(link.downloadUrl);
    if (!res.ok || !res.body) {
      throw new MediaImportError(`Téléchargement refusé (HTTP ${res.status}). Le lien est-il bien public ?`);
    }
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > MAX_IMPORT_BYTES) throw new MediaImportError("Fichier trop volumineux (2 Go maximum).");

    const { _sum } = await db.mediaAsset.aggregate({ where: { userId: asset.userId, status: "READY" }, _sum: { sizeBytes: true } });
    if ((_sum.sizeBytes ?? 0) + declared > USER_STORAGE_CAP_BYTES) {
      throw new MediaImportError("Plafond de stockage atteint (9 Go) : supprimez d'anciens médias dans la médiathèque.");
    }

    const reader = res.body.getReader();
    const head = await peek(reader, 64);
    if (looksLikeHtml(head)) {
      await reader.cancel();
      throw new MediaImportError(
        "Le lien renvoie une page web, pas le fichier : partagez-le en « Tous les utilisateurs disposant du lien » (Google Drive) ou en lien public (Dropbox)."
      );
    }
    const mime = sniffMediaType(head);
    if (!mime) {
      await reader.cancel();
      throw new MediaImportError("Format non supporté : MP4, MOV, WebM, JPEG, PNG ou WebP uniquement.");
    }

    const urlName = decodeURIComponent(new URL(asset.importUrl).pathname.split("/").pop() ?? "");
    const fileName = finalFileName(
      [fileNameFromContentDisposition(res.headers.get("content-disposition")), /\.[a-z0-9]{2,5}$/i.test(urlName) ? urlName : null],
      mime,
      new Date()
    );
    const storageKey = buildStorageKey(asset.userId, fileName);

    // Flux re-composé : octets déjà lus + suite, avec comptage et plafond de taille.
    let total = 0;
    const counted = new ReadableStream<Uint8Array>({
      start(controller) {
        total += head.length;
        controller.enqueue(head);
      },
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done || !value) {
          controller.close();
          return;
        }
        total += value.length;
        if (total > MAX_IMPORT_BYTES) {
          await reader.cancel();
          controller.error(new MediaImportError("Fichier trop volumineux (2 Go maximum)."));
          return;
        }
        controller.enqueue(value);
      },
      async cancel(reason) {
        await reader.cancel(reason);
      },
    });

    uploadedKey = storageKey;
    await uploadStream(storageKey, Readable.fromWeb(counted as unknown as NodeWebReadableStream<Uint8Array>), mime);

    let meta: { width: number | null; height: number | null; durationSec: number | null } = { width: null, height: null, durationSec: null };
    if (mime === "video/mp4" || mime === "video/quicktime") {
      meta = await parseVideoMeta({
        size: total,
        read: (offset, length) => readObjectRange(storageKey, offset, Math.min(offset + length, total) - 1),
      }).catch(() => meta);
    } else if (mime.startsWith("image/") && total <= MAX_IMAGE_BYTES) {
      const info = await sharp(await getObjectBuffer(storageKey)).metadata().catch(() => null);
      if (info?.width && info?.height) {
        const swap = (info.orientation ?? 1) >= 5; // EXIF 5–8 : image tournée de 90°
        meta = { width: swap ? info.height : info.width, height: swap ? info.width : info.height, durationSec: null };
      }
    }

    await db.mediaAsset.update({
      where: { id: mediaAssetId },
      data: {
        status: "READY",
        storageKey,
        mimeType: mime,
        sizeBytes: total,
        width: meta.width,
        height: meta.height,
        durationSec: meta.durationSec,
        importError: null,
      },
    });
  } catch (err) {
    if (uploadedKey) await deleteObject(uploadedKey).catch(() => {});
    if (err instanceof MediaImportError) {
      await markFailed(mediaAssetId, err.message);
      return;
    }
    console.error(`[media-import] échec (média ${mediaAssetId})`, err);
    if (isLastAttempt) {
      await markFailed(mediaAssetId, "Import impossible (erreur réseau ou serveur distant). Réessayez avec le même lien.");
      return;
    }
    throw err;
  }
}
