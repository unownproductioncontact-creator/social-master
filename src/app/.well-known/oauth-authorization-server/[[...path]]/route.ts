import { authorizationServerMetadata } from "@/lib/mcp/oauth-core";
import { issuer, jsonResponse, preflight } from "@/lib/mcp/http";

// RFC 8414 — découverte du serveur d'autorisation du connecteur Claude (CLAUDE.md §29).
export function GET() {
  return jsonResponse(authorizationServerMetadata(issuer()));
}

export function OPTIONS() {
  return preflight();
}
