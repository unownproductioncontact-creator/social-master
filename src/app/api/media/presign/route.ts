import { NextRequest, NextResponse } from "next/server";
import * as z from "zod";
import { verifySession } from "@/lib/dal";
import { db } from "@/lib/db";
import { buildStorageKey, createPresignedUploadUrl } from "@/lib/storage";
import { isAcceptedUploadType, MAX_UPLOAD_SIZE_BYTES } from "@/lib/media-validation";
import { checkRateLimit } from "@/lib/rate-limit";

const PresignRequestSchema = z.object({
  fileName: z.string().min(1),
  mimeType: z.string().min(1),
  sizeBytes: z.number().int().positive(),
  width: z.number().int().positive().nullish(),
  height: z.number().int().positive().nullish(),
  durationSec: z.number().positive().nullish(),
});

const PRESIGN_RATE_LIMIT = { max: 30, windowMs: 60 * 1000 };

// Plafond de stockage PAR requête presign, par utilisateur — garde-fou proactif distinct de
// l'alerte globale à 80 % du palier gratuit (10 Go, voir src/worker/storage-check-job.ts, non
// modifié). Ici on bloque *avant* l'upload si le total déjà READY de l'utilisateur + ce nouveau
// fichier dépasserait 9 Go, en anticipation du futur upload en masse (voir mission).
const USER_STORAGE_CAP_BYTES = 9 * 1024 ** 3;

/**
 * Somme des tailles des médias READY d'un utilisateur. Même pattern Prisma que
 * `runStorageCheck()` dans src/worker/storage-check-job.ts (aggregate + _sum.sizeBytes), mais
 * filtré par `userId` — ce fichier worker ne modélise qu'un total global, pas de fonction
 * paramétrable par utilisateur à importer telle quelle ; le pattern est donc repris ici plutôt
 * que le fichier worker modifié (hors périmètre).
 */
async function getUserStorageUsageBytes(userId: string): Promise<number> {
  const { _sum } = await db.mediaAsset.aggregate({
    where: { userId, status: "READY" },
    _sum: { sizeBytes: true },
  });
  return _sum.sizeBytes ?? 0;
}

export async function POST(req: NextRequest) {
  const session = await verifySession();

  const presignLimit = checkRateLimit(`presign:${session.userId}`, PRESIGN_RATE_LIMIT);
  if (!presignLimit.allowed) {
    return NextResponse.json(
      { error: "Trop de requêtes d'upload, réessayez dans un instant." },
      { status: 429, headers: { "Retry-After": String(presignLimit.retryAfterSec ?? 60) } },
    );
  }

  const parsed = PresignRequestSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "Requête invalide." }, { status: 400 });
  }
  const { fileName, mimeType, sizeBytes, width, height, durationSec } = parsed.data;

  if (!isAcceptedUploadType(mimeType)) {
    return NextResponse.json({ error: "Type de fichier non supporté." }, { status: 415 });
  }
  if (sizeBytes > MAX_UPLOAD_SIZE_BYTES) {
    return NextResponse.json({ error: "Fichier trop volumineux (max 4 Go)." }, { status: 413 });
  }

  const currentUsageBytes = await getUserStorageUsageBytes(session.userId);
  if (currentUsageBytes + sizeBytes > USER_STORAGE_CAP_BYTES) {
    return NextResponse.json(
      {
        error:
          "Plafond de stockage atteint (9 Go). Supprimez d'anciens médias dans la médiathèque avant d'en ajouter de nouveaux.",
      },
      { status: 413 },
    );
  }

  const storageKey = buildStorageKey(session.userId, fileName);

  const mediaAsset = await db.mediaAsset.create({
    data: {
      userId: session.userId,
      storageKey,
      mimeType,
      sizeBytes,
      width: width ?? undefined,
      height: height ?? undefined,
      durationSec: durationSec ?? undefined,
      status: "UPLOADING",
    },
  });

  const uploadUrl = await createPresignedUploadUrl(storageKey, mimeType);

  return NextResponse.json({ mediaAssetId: mediaAsset.id, uploadUrl });
}
