import { completeUploadForUser } from "@/lib/media-upload";
import { authenticateBearer, unauthorized } from "@/lib/mcp/bearer";
import { jsonResponse, preflight } from "@/lib/mcp/http";

/** Envoi depuis le Mac, étape 2 : vérifie l'objet R2, détermine type réel + métadonnées, passe READY. */
export async function POST(req: Request, ctx: RouteContext<"/api/mcp/media/[id]/complete">) {
  const auth = await authenticateBearer(req);
  if (!auth) return unauthorized();
  const { id } = await ctx.params;
  const result = await completeUploadForUser(auth.userId, id, { describe: true });
  if (!result.ok) return jsonResponse({ error: result.error }, result.status);
  const m = result.media;
  return jsonResponse({
    media_id: m.id,
    status: "ready",
    kind: m.mimeType.startsWith("video/") ? "video" : "image",
    size_mb: Math.round((m.sizeBytes / (1024 * 1024)) * 10) / 10,
    duration_s: m.durationSec ?? undefined,
    width: m.width ?? undefined,
    height: m.height ?? undefined,
  });
}

export function OPTIONS() {
  return preflight();
}
