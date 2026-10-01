import "server-only";
import { bearerToken } from "@/lib/mcp/oauth-core";
import { authenticateAccessToken } from "@/lib/mcp/oauth-store";
import { issuer, jsonResponse } from "@/lib/mcp/http";

export type BearerAuth = NonNullable<Awaited<ReturnType<typeof authenticateAccessToken>>> & { token: string };

/** Jeton OAuth du connecteur (en-tête Authorization: Bearer) → identité, ou null. */
export async function authenticateBearer(req: Request): Promise<BearerAuth | null> {
  const token = bearerToken(req.headers.get("authorization"));
  const auth = token ? await authenticateAccessToken(token) : null;
  return token && auth ? { ...auth, token } : null;
}

/** 401 standard : WWW-Authenticate pointe vers les métadonnées de ressource protégée (RFC 9728). */
export function unauthorized(): Response {
  return jsonResponse({ error: "invalid_token", error_description: "Jeton d'accès manquant, expiré ou révoqué." }, 401, {
    "WWW-Authenticate": `Bearer resource_metadata="${issuer()}/.well-known/oauth-protected-resource"`,
  });
}
