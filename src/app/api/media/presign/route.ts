import { NextRequest, NextResponse } from "next/server";
import { verifySession } from "@/lib/dal";
import { startUploadForUser } from "@/lib/media-upload";

/** Upload navigateur → R2 (étape 1) : logique partagée dans src/lib/media-upload.ts (CLAUDE.md §31). */
export async function POST(req: NextRequest) {
  const session = await verifySession();
  const result = await startUploadForUser(session.userId, await req.json().catch(() => null));
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error },
      { status: result.status, headers: result.retryAfterSec ? { "Retry-After": String(result.retryAfterSec) } : undefined }
    );
  }
  return NextResponse.json({ mediaAssetId: result.mediaAssetId, uploadUrl: result.uploadUrl });
}
