import "server-only";
import { lookup } from "node:dns/promises";
import { Readable } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { db } from "@/lib/db";
import { buildStorageKey, deleteObject, mediaWorkerPushConfig, uploadStream } from "@/lib/storage";
import { importViaWorker } from "@/lib/media-worker";
import { resolveShareLink } from "@/lib/media-import/share-link";
import { isPublicIp } from "@/lib/media-import/network-guard";
import {
  fileNameFromContentDisposition,
  finalFileName,
  looksLikeHtml,
  sniffMediaType,
  type ImportedMime,
} from "@/lib/media-import/sniff";
import { describeStoredMedia } from "@/lib/media-import/describe";
import { MediaImportError } from "@/lib/media-import/errors";

export { MediaImportError };

/**
 * Import d'un média depuis un lien (Google Drive, Dropbox, lien direct) — CLAUDE.md §30. Lancé par
 * l'outil MCP `import_media_from_url` via la file pg-boss `media-import` (le serveur télécharge, pas le
 * téléphone : marche depuis n'importe quelle conversation Claude et contourne les réseaux qui bloquent
 * R2). Jamais le fichier entier en RAM (règle n°7).
 *
 * Chemin normal (Worker Cloudflare configuré, §36) : Render n'ouvre le lien que pour reconnaître le
 * fichier (quelques octets, entrée gratuite), puis le Worker le télécharge et l'écrit lui-même dans
 * R2 — la sortie de Render, facturée au-delà de 5 Go/mois, n'est plus sollicitée. Chemin direct
 * (Render → R2) conservé quand le Worker n'est pas configuré, quand le serveur distant n'annonce pas
 * la taille du fichier, ou quand le Worker est indisponible.
 */

// `sizeBytes` est un Int Postgres (≤ 2 147 483 647) : plafond sous 2 Go.
const MAX_IMPORT_BYTES = 2_000_000_000;
const USER_STORAGE_CAP_BYTES = 9 * 1024 ** 3; // même plafond que l'upload navigateur (presign)
const MAX_REDIRECTS = 5;
const DOWNLOAD_TIMEOUT_MS = 20 * 60 * 1000;

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

/** Lien ouvert et reconnu : le lecteur est positionné APRÈS les `head.length` premiers octets. */
type OpenedSource = {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  head: Uint8Array;
  mime: ImportedMime;
  /** Taille annoncée par le serveur (0 = inconnue). */
  declared: number;
  contentEncoding: string | null;
  contentDisposition: string | null;
};

/** Ouvre le lien, vérifie qu'il s'agit bien d'un média et en reconnaît le type par ses premiers octets. */
async function openSource(downloadUrl: string): Promise<OpenedSource> {
  const res = await safeFetch(downloadUrl);
  if (!res.ok || !res.body) {
    throw new MediaImportError(`Téléchargement refusé (HTTP ${res.status}). Le lien est-il bien public ?`);
  }
  const declared = Number(res.headers.get("content-length") ?? "0") || 0;
  if (declared > MAX_IMPORT_BYTES) {
    await res.body.cancel();
    throw new MediaImportError("Fichier trop volumineux (2 Go maximum).");
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
  const encoding = res.headers.get("content-encoding")?.toLowerCase();
  return {
    reader,
    head,
    mime,
    declared,
    contentEncoding: encoding && encoding !== "identity" ? encoding : null,
    contentDisposition: res.headers.get("content-disposition"),
  };
}

/** Chemin direct : le flux (octets déjà lus + suite) est envoyé vers R2 en multipart, plafond et comptage inclus. */
async function streamDirect(source: OpenedSource, storageKey: string): Promise<number> {
  const { reader, head } = source;
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

  await uploadStream(storageKey, Readable.fromWeb(counted as unknown as NodeWebReadableStream<Uint8Array>), source.mime);
  return total;
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
  let source: OpenedSource | null = null;
  try {
    const link = resolveShareLink(asset.importUrl);
    if (!link.ok) throw new MediaImportError(link.error);

    source = await openSource(link.downloadUrl);

    const { _sum } = await db.mediaAsset.aggregate({ where: { userId: asset.userId, status: "READY" }, _sum: { sizeBytes: true } });
    if ((_sum.sizeBytes ?? 0) + source.declared > USER_STORAGE_CAP_BYTES) {
      throw new MediaImportError("Plafond de stockage atteint (9 Go) : supprimez d'anciens médias dans la médiathèque.");
    }

    const urlName = decodeURIComponent(new URL(asset.importUrl).pathname.split("/").pop() ?? "");
    const fileName = finalFileName(
      [fileNameFromContentDisposition(source.contentDisposition), /\.[a-z0-9]{2,5}$/i.test(urlName) ? urlName : null],
      source.mime,
      new Date()
    );
    let storageKey = buildStorageKey(asset.userId, fileName);
    let total: number | null = null;
    let via: "worker" | "direct" = "direct";

    const worker = mediaWorkerPushConfig();
    if (worker && source.declared > 0 && !source.contentEncoding) {
      // L'ouverture ci-dessus n'a servi qu'à reconnaître le fichier (quelques octets) : on lâche le
      // flux et c'est le Worker qui télécharge le fichier entier, directement vers R2.
      await source.reader.cancel().catch(() => {});
      uploadedKey = storageKey;
      const outcome = await importViaWorker(worker, {
        url: link.downloadUrl,
        key: storageKey,
        maxBytes: MAX_IMPORT_BYTES,
        contentType: source.mime,
      });
      if (outcome.kind === "ok") {
        total = outcome.size;
        via = "worker";
      } else if (outcome.kind === "refused") {
        throw new MediaImportError(outcome.message);
      } else {
        // Worker inutilisable pour ce fichier ou indisponible : import direct depuis Render, sous une
        // clé NEUVE (on n'écrase jamais ce que le Worker aurait pu commencer à écrire).
        console.warn(`[media-import] média ${mediaAssetId} : import direct (Worker : ${outcome.reason})`);
        await deleteObject(storageKey).catch(() => {});
        uploadedKey = null;
        source = await openSource(link.downloadUrl);
        storageKey = buildStorageKey(asset.userId, fileName);
      }
    }
    if (total === null) {
      uploadedKey = storageKey;
      total = await streamDirect(source, storageKey);
    }

    const meta = await describeStoredMedia(storageKey, total);

    await db.mediaAsset.update({
      where: { id: mediaAssetId },
      data: {
        status: "READY",
        storageKey,
        mimeType: meta.mime,
        sizeBytes: total,
        width: meta.width,
        height: meta.height,
        durationSec: meta.durationSec,
        importError: null,
      },
    });
    console.log(`[media-import] média ${mediaAssetId} prêt (${total} octets, import ${via === "worker" ? "par le Worker Cloudflare" : "direct"})`);
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
  } finally {
    // Libère la connexion si l'import s'est arrêté avant d'avoir consommé le flux (refus, quota…).
    await source?.reader.cancel().catch(() => {});
  }
}
