import { NextRequest } from "next/server";
import { isAcceptableRedirectUri } from "@/lib/mcp/oauth-core";
import { registerClient } from "@/lib/mcp/oauth-store";
import { jsonResponse, preflight } from "@/lib/mcp/http";
import { checkRateLimit } from "@/lib/rate-limit";

/**
 * Enregistrement dynamique de client (RFC 7591), utilisé par Claude à l'ajout du connecteur.
 * Ouvert par nature : enregistrer un client ne donne AUCUN accès — il faut encore que l'utilisateur
 * se connecte et consente explicitement sur /oauth/authorize. Limité en fréquence par IP.
 */
export async function POST(req: NextRequest) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (!checkRateLimit(`oauth-register:${ip}`, { max: 20, windowMs: 60 * 60 * 1000 }).allowed) {
    return jsonResponse({ error: "too_many_requests" }, 429);
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return jsonResponse({ error: "invalid_client_metadata", error_description: "Corps JSON invalide." }, 400);
  }

  const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u): u is string => typeof u === "string") : [];
  if (redirectUris.length === 0 || redirectUris.length > 10 || !redirectUris.every(isAcceptableRedirectUri)) {
    return jsonResponse({ error: "invalid_redirect_uri", error_description: "redirect_uris : https (ou http localhost) requis." }, 400);
  }

  const name = typeof body.client_name === "string" ? body.client_name : "Client MCP";
  const requestedMethod = typeof body.token_endpoint_auth_method === "string" ? body.token_endpoint_auth_method : "none";
  const client = await registerClient({ name, redirectUris, tokenEndpointAuthMethod: requestedMethod });

  return jsonResponse(
    {
      client_id: client.clientId,
      client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
      client_name: name,
      redirect_uris: redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: client.tokenEndpointAuthMethod,
      ...(client.clientSecret ? { client_secret: client.clientSecret, client_secret_expires_at: 0 } : {}),
    },
    201
  );
}

export function OPTIONS() {
  return preflight();
}
