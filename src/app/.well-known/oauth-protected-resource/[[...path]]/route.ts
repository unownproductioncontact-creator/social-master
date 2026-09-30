import { protectedResourceMetadata } from "@/lib/mcp/oauth-core";
import { issuer, jsonResponse, preflight } from "@/lib/mcp/http";

// RFC 9728 — servi aussi sous /.well-known/oauth-protected-resource/api/mcp (forme « avec chemin »).
export function GET() {
  return jsonResponse(protectedResourceMetadata(issuer()));
}

export function OPTIONS() {
  return preflight();
}
