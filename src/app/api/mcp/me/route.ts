import { db } from "@/lib/db";
import { authenticateBearer, unauthorized } from "@/lib/mcp/bearer";
import { issuer, jsonResponse, preflight } from "@/lib/mcp/http";

/** Identité du jeton (utilisé par l'outil d'envoi depuis le Mac pour vérifier sa connexion, §31). */
export async function GET(req: Request) {
  const auth = await authenticateBearer(req);
  if (!auth) return unauthorized();
  const user = await db.user.findUnique({ where: { id: auth.userId }, select: { email: true } });
  return jsonResponse({ email: user?.email ?? null, app_url: issuer() });
}

export function OPTIONS() {
  return preflight();
}
