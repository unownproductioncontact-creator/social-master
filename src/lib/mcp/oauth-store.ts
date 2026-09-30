import "server-only";
import { db } from "@/lib/db";
import {
  ACCESS_TOKEN_TTL_S,
  AUTH_CODE_TTL_S,
  MCP_SCOPE,
  REFRESH_TOKEN_TTL_S,
  randomToken,
  safeEqual,
  sha256Hex,
  verifyPkceS256,
} from "@/lib/mcp/oauth-core";

/**
 * Persistance du serveur d'autorisation OAuth du connecteur Claude (CLAUDE.md §29). Tous les secrets
 * (codes, jetons, secrets clients) sont stockés HASHÉS ; les opérations sensibles (consommation d'un
 * code, rotation d'un refresh token) sont des mises à jour CONDITIONNELLES (anti-rejeu concurrent).
 */

export type OAuthError = { error: string; error_description?: string };
export type TokenResponse = {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
};

const SECRET_AUTH_METHODS = new Set(["client_secret_post", "client_secret_basic"]);

export async function registerClient(input: {
  name: string;
  redirectUris: string[];
  tokenEndpointAuthMethod: string;
}): Promise<{ clientId: string; clientSecret?: string; tokenEndpointAuthMethod: string; createdAt: Date }> {
  const method = SECRET_AUTH_METHODS.has(input.tokenEndpointAuthMethod) ? input.tokenEndpointAuthMethod : "none";
  const clientSecret = method === "none" ? undefined : randomToken(32);
  const client = await db.oAuthClient.create({
    data: {
      name: input.name.slice(0, 100) || "Client MCP",
      redirectUris: input.redirectUris,
      tokenEndpointAuthMethod: method,
      secretHash: clientSecret ? sha256Hex(clientSecret) : null,
    },
  });
  return { clientId: client.id, clientSecret, tokenEndpointAuthMethod: method, createdAt: client.createdAt };
}

export async function findClient(clientId: string) {
  return db.oAuthClient.findUnique({ where: { id: clientId } });
}

/** Vérifie l'authentification du client au point de jeton (aucune pour un client public + PKCE). */
export function clientAuthenticated(
  client: { tokenEndpointAuthMethod: string; secretHash: string | null },
  providedSecret: string | null
): boolean {
  if (client.tokenEndpointAuthMethod === "none") return true;
  return Boolean(client.secretHash && providedSecret && safeEqual(sha256Hex(providedSecret), client.secretHash));
}

/** Émet un code d'autorisation (usage unique, 10 min) après consentement explicite de l'utilisateur. */
export async function createAuthorizationCode(input: {
  clientId: string;
  userId: string;
  redirectUri: string;
  codeChallenge: string;
}): Promise<string> {
  const code = randomToken(32);
  await db.oAuthAuthCode.create({
    data: {
      codeHash: sha256Hex(code),
      clientId: input.clientId,
      userId: input.userId,
      redirectUri: input.redirectUri,
      codeChallenge: input.codeChallenge,
      scope: MCP_SCOPE,
      expiresAt: new Date(Date.now() + AUTH_CODE_TTL_S * 1000),
    },
  });
  return code;
}

async function issueTokens(clientId: string, userId: string): Promise<TokenResponse> {
  const accessToken = randomToken(32);
  const refreshToken = randomToken(48);
  const now = Date.now();
  await db.oAuthToken.create({
    data: {
      clientId,
      userId,
      accessTokenHash: sha256Hex(accessToken),
      refreshTokenHash: sha256Hex(refreshToken),
      scope: MCP_SCOPE,
      accessExpiresAt: new Date(now + ACCESS_TOKEN_TTL_S * 1000),
      refreshExpiresAt: new Date(now + REFRESH_TOKEN_TTL_S * 1000),
    },
  });
  return { access_token: accessToken, token_type: "Bearer", expires_in: ACCESS_TOKEN_TTL_S, refresh_token: refreshToken, scope: MCP_SCOPE };
}

/** grant_type=authorization_code : code valide, non consommé, même client, même redirect_uri, PKCE OK. */
export async function exchangeAuthorizationCode(input: {
  code: string;
  clientId: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<TokenResponse | OAuthError> {
  const record = await db.oAuthAuthCode.findUnique({ where: { codeHash: sha256Hex(input.code) } });
  if (!record || record.usedAt || record.expiresAt.getTime() < Date.now()) {
    return { error: "invalid_grant", error_description: "Code d'autorisation invalide ou expiré." };
  }
  if (record.clientId !== input.clientId || record.redirectUri !== input.redirectUri) {
    return { error: "invalid_grant", error_description: "Code émis pour un autre client ou une autre redirection." };
  }
  if (!verifyPkceS256(input.codeVerifier, record.codeChallenge)) {
    return { error: "invalid_grant", error_description: "Vérification PKCE échouée." };
  }
  // Consommation atomique : un code rejoué (même en parallèle) n'émet jamais deux paires de jetons.
  const consumed = await db.oAuthAuthCode.updateMany({ where: { id: record.id, usedAt: null }, data: { usedAt: new Date() } });
  if (consumed.count !== 1) return { error: "invalid_grant", error_description: "Code déjà utilisé." };
  return issueTokens(record.clientId, record.userId);
}

/** grant_type=refresh_token : rotation (l'ancien refresh token devient immédiatement inutilisable). */
export async function refreshAccessToken(input: { refreshToken: string; clientId: string }): Promise<TokenResponse | OAuthError> {
  const oldHash = sha256Hex(input.refreshToken);
  const record = await db.oAuthToken.findUnique({ where: { refreshTokenHash: oldHash } });
  if (!record || record.revokedAt || record.refreshExpiresAt.getTime() < Date.now() || record.clientId !== input.clientId) {
    return { error: "invalid_grant", error_description: "Jeton de rafraîchissement invalide, expiré ou révoqué." };
  }
  const accessToken = randomToken(32);
  const refreshToken = randomToken(48);
  const now = Date.now();
  const rotated = await db.oAuthToken.updateMany({
    where: { id: record.id, refreshTokenHash: oldHash, revokedAt: null },
    data: {
      accessTokenHash: sha256Hex(accessToken),
      refreshTokenHash: sha256Hex(refreshToken),
      accessExpiresAt: new Date(now + ACCESS_TOKEN_TTL_S * 1000),
      refreshExpiresAt: new Date(now + REFRESH_TOKEN_TTL_S * 1000),
    },
  });
  if (rotated.count !== 1) return { error: "invalid_grant", error_description: "Jeton de rafraîchissement déjà utilisé." };
  return { access_token: accessToken, token_type: "Bearer", expires_in: ACCESS_TOKEN_TTL_S, refresh_token: refreshToken, scope: record.scope };
}

const LAST_USED_THROTTLE_MS = 5 * 60 * 1000;

/** Résout un jeton d'accès présenté au serveur MCP (null si inconnu, expiré ou révoqué). */
export async function authenticateAccessToken(
  accessToken: string
): Promise<{ userId: string; clientId: string; tokenId: string; scope: string; expiresAt: Date } | null> {
  const record = await db.oAuthToken.findUnique({ where: { accessTokenHash: sha256Hex(accessToken) } });
  if (!record || record.revokedAt || record.accessExpiresAt.getTime() < Date.now()) return null;
  if (!record.lastUsedAt || Date.now() - record.lastUsedAt.getTime() > LAST_USED_THROTTLE_MS) {
    await db.oAuthToken.update({ where: { id: record.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
  }
  return { userId: record.userId, clientId: record.clientId, tokenId: record.id, scope: record.scope, expiresAt: record.accessExpiresAt };
}

/** Accès actifs d'un utilisateur (Paramètres → Claude). */
export async function listActiveGrants(userId: string) {
  const tokens = await db.oAuthToken.findMany({
    where: { userId, revokedAt: null, refreshExpiresAt: { gt: new Date() } },
    include: { client: true },
    orderBy: { createdAt: "desc" },
  });
  return tokens.map((t) => ({ id: t.id, clientName: t.client.name, createdAt: t.createdAt, lastUsedAt: t.lastUsedAt }));
}

/** Révoque un accès (effet immédiat sur le jeton d'accès ET le refresh token). Scopé par userId. */
export async function revokeGrant(userId: string, tokenId: string): Promise<boolean> {
  const res = await db.oAuthToken.updateMany({ where: { id: tokenId, userId, revokedAt: null }, data: { revokedAt: new Date() } });
  return res.count === 1;
}
