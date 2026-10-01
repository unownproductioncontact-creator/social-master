import "server-only";
import * as z from "zod";
import { db } from "@/lib/db";
import { buildStorageKey, createPresignedUploadUrl, deleteObject, getPublicMediaUrl, headObject } from "@/lib/storage";
import { isAcceptedUploadType, MAX_UPLOAD_SIZE_BYTES } from "@/lib/media-validation";
import { checkRateLimit } from "@/lib/rate-limit";
import { describeStoredMedia } from "@/lib/media-import/describe";
import { MediaImportError } from "@/lib/media-import/errors";

/**
 * Envoi direct d'un média vers R2 (URL présignée), SCOPÉ PAR userId — partagé par la médiathèque web
 * (session, /api/media/…) et l'outil d'envoi depuis le Mac (jeton OAuth, /api/mcp/media/…, CLAUDE.md §31).
 * Le fichier ne transite JAMAIS par le serveur : le client le PUT directement sur R2.
 */

const PresignRequestSchema = z.object({
  fileName: z.string().min(1),
  mimeType: z.string().min(1),
  sizeBytes: z.number().int().positive(),
  width: z.number().int().positive().nullish(),
  height: z.number().int().positive().nullish(),
  durationSec: z.number().positive().nullish(),
});

const PRESIGN_RATE_LIMIT = { max: 30, windowMs: 60 * 1000 };

// Plafond de stockage PAR requête presign, par utilisateur — garde-fou proactif distinct de l'alerte
// globale à 80 % du palier gratuit (10 Go, voir src/worker/storage-check-job.ts) : on bloque *avant*
// l'upload si le total déjà READY de l'utilisateur + ce nouveau fichier dépasserait 9 Go.
const USER_STORAGE_CAP_BYTES = 9 * 1024 ** 3;

async function getUserStorageUsageBytes(userId: string): Promise<number> {
  const { _sum } = await db.mediaAsset.aggregate({ where: { userId, status: "READY" }, _sum: { sizeBytes: true } });
  return _sum.sizeBytes ?? 0;
}

export type UploadFailure = { ok: false; status: number; error: string; retryAfterSec?: number };

export async function startUploadForUser(
  userId: string,
  rawInput: unknown,
  options: { maxSizeBytes?: number } = {}
): Promise<{ ok: true; mediaAssetId: string; uploadUrl: string } | UploadFailure> {
  const limit = checkRateLimit(`presign:${userId}`, PRESIGN_RATE_LIMIT);
  if (!limit.allowed) {
    return { ok: false, status: 429, error: "Trop de requêtes d'upload, réessayez dans un instant.", retryAfterSec: limit.retryAfterSec ?? 60 };
  }
  const parsed = PresignRequestSchema.safeParse(rawInput);
  if (!parsed.success) return { ok: false, status: 400, error: "Requête invalide." };
  const { fileName, mimeType, sizeBytes, width, height, durationSec } = parsed.data;

  if (!isAcceptedUploadType(mimeType)) return { ok: false, status: 415, error: "Type de fichier non supporté." };
  const maxSize = options.maxSizeBytes ?? MAX_UPLOAD_SIZE_BYTES;
  if (sizeBytes > maxSize) {
    return { ok: false, status: 413, error: `Fichier trop volumineux (max ${Math.round(maxSize / 1024 ** 3)} Go).` };
  }
  if ((await getUserStorageUsageBytes(userId)) + sizeBytes > USER_STORAGE_CAP_BYTES) {
    return {
      ok: false,
      status: 413,
      error: "Plafond de stockage atteint (9 Go). Supprimez d'anciens médias dans la médiathèque avant d'en ajouter de nouveaux.",
    };
  }

  const storageKey = buildStorageKey(userId, fileName);
  const mediaAsset = await db.mediaAsset.create({
    data: {
      userId,
      storageKey,
      mimeType,
      sizeBytes,
      width: width ?? undefined,
      height: height ?? undefined,
      durationSec: durationSec ?? undefined,
      status: "UPLOADING",
    },
  });
  return { ok: true, mediaAssetId: mediaAsset.id, uploadUrl: await createPresignedUploadUrl(storageKey, mimeType) };
}

export type CompletedMedia = {
  id: string;
  storageKey: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  durationSec: number | null;
};

/**
 * Le client déclare avoir terminé son PUT : on vérifie que l'objet existe vraiment sur R2 avant de
 * passer READY, et on recale la taille. `describe` (envoi depuis le Mac) : le serveur détermine aussi
 * le type réel et les métadonnées (le navigateur, lui, les fournit au presign).
 */
export async function completeUploadForUser(
  userId: string,
  mediaAssetId: string,
  options: { describe: boolean }
): Promise<{ ok: true; publicUrl: string; media: CompletedMedia } | UploadFailure> {
  const asset = await db.mediaAsset.findUnique({ where: { id: mediaAssetId } });
  if (!asset || asset.userId !== userId) return { ok: false, status: 404, error: "Média introuvable." };

  const head = await headObject(asset.storageKey);
  if (head.outcome === "not_found") {
    // Statut laissé à UPLOADING : un nouvel appel pourra réussir si le PUT était encore en vol.
    return { ok: false, status: 409, error: "Fichier introuvable sur le stockage, réessayez l'upload." };
  }
  if (head.outcome === "error") {
    // Tolérant par design : un aléa réseau/R2 ponctuel ne doit pas bloquer l'utilisateur.
    console.error("[media/complete] HeadObject R2 a échoué, on accepte quand même", {
      mediaAssetId,
      storageKey: asset.storageKey,
      error: head.error,
    });
  }
  const sizeBytes = head.outcome === "found" ? head.sizeBytes : asset.sizeBytes;

  let described: { mime: string; width: number | null; height: number | null; durationSec: number | null } | null = null;
  if (options.describe && head.outcome === "found") {
    try {
      described = await describeStoredMedia(asset.storageKey, sizeBytes);
    } catch (err) {
      if (!(err instanceof MediaImportError)) throw err;
      await deleteObject(asset.storageKey).catch(() => {});
      await db.mediaAsset.update({ where: { id: mediaAssetId }, data: { status: "FAILED", importError: err.message } });
      return { ok: false, status: 415, error: err.message };
    }
  }

  const updated = await db.mediaAsset.update({
    where: { id: mediaAssetId },
    data: {
      status: "READY",
      sizeBytes,
      ...(described
        ? {
            mimeType: described.mime,
            width: described.width ?? asset.width,
            height: described.height ?? asset.height,
            durationSec: described.durationSec ?? asset.durationSec,
          }
        : {}),
    },
  });
  return {
    ok: true,
    publicUrl: getPublicMediaUrl(asset.storageKey),
    media: {
      id: updated.id,
      storageKey: updated.storageKey,
      mimeType: updated.mimeType,
      sizeBytes: updated.sizeBytes,
      width: updated.width,
      height: updated.height,
      durationSec: updated.durationSec,
    },
  };
}
