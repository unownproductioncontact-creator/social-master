import { NextRequest } from "next/server";
import { clientAuthenticated, exchangeAuthorizationCode, findClient, refreshAccessToken } from "@/lib/mcp/oauth-store";
import { jsonResponse, preflight } from "@/lib/mcp/http";

/**
 * Point de jeton OAuth (CLAUDE.md §29) : `authorization_code` (+ PKCE S256) et `refresh_token`
 * (rotation). Corps application/x-www-form-urlencoded ; secret client éventuel en corps (post) ou en
 * en-tête Basic. Réponses sans cache.
 */
export async function POST(req: NextRequest) {
  let form: URLSearchParams;
  try {
    form = new URLSearchParams(await req.text());
  } catch {
    return jsonResponse({ error: "invalid_request" }, 400);
  }

  // Identifiants client : corps (client_id/client_secret) ou en-tête Basic.
  let clientId = form.get("client_id");
  let clientSecret = form.get("client_secret");
  const basic = req.headers.get("authorization")?.match(/^Basic\s+(.+)$/i);
  if (basic) {
    const decoded = Buffer.from(basic[1], "base64").toString("utf8");
    const sep = decoded.indexOf(":");
    if (sep > 0) {
      clientId = decodeURIComponent(decoded.slice(0, sep));
      clientSecret = decodeURIComponent(decoded.slice(sep + 1));
    }
  }
  if (!clientId) return jsonResponse({ error: "invalid_client", error_description: "client_id manquant." }, 401);
  const client = await findClient(clientId);
  if (!client || !clientAuthenticated(client, clientSecret)) {
    return jsonResponse({ error: "invalid_client" }, 401);
  }

  const grantType = form.get("grant_type");
  if (grantType === "authorization_code") {
    const code = form.get("code");
    const redirectUri = form.get("redirect_uri");
    const codeVerifier = form.get("code_verifier");
    if (!code || !redirectUri || !codeVerifier) {
      return jsonResponse({ error: "invalid_request", error_description: "code, redirect_uri et code_verifier requis." }, 400);
    }
    const result = await exchangeAuthorizationCode({ code, clientId, redirectUri, codeVerifier });
    return "error" in result ? jsonResponse(result, 400) : jsonResponse(result);
  }

  if (grantType === "refresh_token") {
    const refreshToken = form.get("refresh_token");
    if (!refreshToken) return jsonResponse({ error: "invalid_request", error_description: "refresh_token requis." }, 400);
    const result = await refreshAccessToken({ refreshToken, clientId });
    return "error" in result ? jsonResponse(result, 400) : jsonResponse(result);
  }

  return jsonResponse({ error: "unsupported_grant_type" }, 400);
}

export function OPTIONS() {
  return preflight();
}
