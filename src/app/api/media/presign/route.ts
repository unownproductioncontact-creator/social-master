import { NextRequest, NextResponse } from "next/server";
import * as z from "zod";
import { verifySession } from "@/lib/dal";
import { db } from "@/lib/db";
import { buildStorageKey, createPresignedUploadUrl } from "@/lib/storage";
import { isAcceptedUploadType, MAX_UPLOAD_SIZE_BYTES } from "@/lib/media-validation";

const PresignRequestSchema = z.object({
  fileName: z.string().min(1),
  mimeType: z.string().min(1),
  sizeBytes: z.number().int().positive(),
  width: z.number().int().positive().nullish(),
  height: z.number().int().positive().nullish(),
  durationSec: z.number().positive().nullish(),
});

export async function POST(req: NextRequest) {
  const session = await verifySession();

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
