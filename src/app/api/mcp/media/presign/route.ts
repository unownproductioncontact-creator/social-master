import { startUploadForUser } from "@/lib/media-upload";
import { authenticateBearer, unauthorized } from "@/lib/mcp/bearer";
import { jsonResponse, preflight } from "@/lib/mcp/http";

// `sizeBytes` est un Int Postgres : plafond sous 2 Go pour l'envoi depuis le Mac.
const MAX_MAC_UPLOAD_BYTES = 2_000_000_000;

/** Envoi depuis le Mac (CLAUDE.md §31), étape 1 : réserve le média et renvoie une URL présignée R2. */
export async function POST(req: Request) {
  const auth = await authenticateBearer(req);
  if (!auth) return unauthorized();
  const result = await startUploadForUser(auth.userId, await req.json().catch(() => null), { maxSizeBytes: MAX_MAC_UPLOAD_BYTES });
  if (!result.ok) return jsonResponse({ error: result.error }, result.status);
  return jsonResponse({ media_id: result.mediaAssetId, upload_url: result.uploadUrl });
}

export function OPTIONS() {
  return preflight();
}
