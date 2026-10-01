import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { mcpResourceUrl } from "@/lib/mcp/oauth-core";
import { authenticateBearer, unauthorized } from "@/lib/mcp/bearer";
import { buildMcpServer } from "@/lib/mcp/server";
import { CORS_HEADERS, issuer, jsonResponse, preflight } from "@/lib/mcp/http";

export const dynamic = "force-dynamic";

/**
 * Serveur MCP distant du connecteur Claude (Streamable HTTP, SANS état, réponses JSON — CLAUDE.md §29).
 * Chaque requête doit porter un jeton OAuth valide ; sinon 401 + WWW-Authenticate pointant vers les
 * métadonnées de ressource protégée (RFC 9728), ce qui déclenche la connexion OAuth côté Claude.
 */
export async function POST(req: Request): Promise<Response> {
  const auth = await authenticateBearer(req);
  if (!auth) return unauthorized();

  const server = await buildMcpServer(auth.userId);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  const response = await transport.handleRequest(req, {
    authInfo: {
      token: auth.token,
      clientId: auth.clientId,
      scopes: [auth.scope],
      expiresAt: Math.floor(auth.expiresAt.getTime() / 1000),
      resource: new URL(mcpResourceUrl(issuer())),
      extra: { userId: auth.userId },
    },
  });
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) headers.set(key, value);
  return new Response(response.body, { status: response.status, headers });
}

/** Pas de flux SSE serveur→client ni de sessions en mode sans état. */
function methodNotAllowed(): Response {
  return jsonResponse({ error: "method_not_allowed" }, 405, { Allow: "POST, OPTIONS" });
}

export const GET = methodNotAllowed;
export const DELETE = methodNotAllowed;

export function OPTIONS() {
  return preflight();
}
