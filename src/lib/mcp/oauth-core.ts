/**
 * Cœur PUR du serveur d'autorisation OAuth 2.1 du connecteur Claude (CLAUDE.md §29) : génération et
 * hachage des secrets, PKCE S256 (RFC 7636), validation des URI de redirection, métadonnées de
 * découverte (RFC 8414 serveur d'autorisation, RFC 9728 ressource protégée). Aucune I/O — testé dans
 * oauth-core.test.ts. La persistance vit dans oauth-store.ts.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Scope unique : accès complet (consulter + agir) au compte Social Master de l'utilisateur. */
export const MCP_SCOPE = "social-master";
export const AUTH_CODE_TTL_S = 10 * 60;
export const ACCESS_TOKEN_TTL_S = 60 * 60;
export const REFRESH_TOKEN_TTL_S = 90 * 24 * 60 * 60;

/** Secret aléatoire (code, jeton, secret client), encodé base64url. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** Empreinte stockée en base à la place du secret (jamais le secret en clair). */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Comparaison à temps constant de deux chaînes. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** PKCE S256 : BASE64URL(SHA256(code_verifier)) doit égaler le code_challenge reçu à l'autorisation. */
export function verifyPkceS256(codeVerifier: string, codeChallenge: string): boolean {
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(codeVerifier)) return false;
  return safeEqual(createHash("sha256").update(codeVerifier).digest("base64url"), codeChallenge);
}

/**
 * URI de redirection acceptée à l'enregistrement d'un client : https, ou http sur la boucle locale
 * (applications natives, RFC 8252 — ex. Claude Code). Jamais de fragment ni d'autre schéma.
 */
export function isAcceptableRedirectUri(uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.hash) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

/** Construit l'URL de retour vers le client avec les paramètres donnés (code/state ou error/state). */
export function buildRedirect(redirectUri: string, params: Record<string, string | undefined>): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}

/** Émetteur = origine publique de l'app (APP_URL sans slash final). */
export function issuerFrom(appUrl: string): string {
  return appUrl.replace(/\/+$/, "");
}

export function mcpResourceUrl(issuer: string): string {
  return `${issuer}/api/mcp`;
}

/** Métadonnées du serveur d'autorisation (RFC 8414). */
export function authorizationServerMetadata(issuer: string) {
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/api/oauth/mcp/token`,
    registration_endpoint: `${issuer}/api/oauth/mcp/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    scopes_supported: [MCP_SCOPE],
  };
}

/** Métadonnées de la ressource protégée (RFC 9728) — pointées par l'en-tête WWW-Authenticate des 401. */
export function protectedResourceMetadata(issuer: string) {
  return {
    resource: mcpResourceUrl(issuer),
    authorization_servers: [issuer],
    scopes_supported: [MCP_SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "Social Master",
  };
}

/** Extrait le jeton d'un en-tête « Authorization: Bearer … » (null sinon). */
export function bearerToken(authorizationHeader: string | null): string | null {
  const match = authorizationHeader?.match(/^Bearer\s+(\S+)$/i);
  return match ? match[1] : null;
}
