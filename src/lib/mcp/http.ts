import "server-only";
import { appUrl } from "@/lib/app-url";
import { issuerFrom } from "@/lib/mcp/oauth-core";

/** Émetteur OAuth = origine publique de l'app (APP_URL). */
export function issuer(): string {
  return issuerFrom(appUrl());
}

/** CORS permissif : ces points de terminaison sont publics et protégés par OAuth/PKCE, pas par l'origine. */
export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Protocol-Version, Mcp-Session-Id",
  "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id",
};

export function jsonResponse(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS_HEADERS, ...extraHeaders },
  });
}

export function preflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
