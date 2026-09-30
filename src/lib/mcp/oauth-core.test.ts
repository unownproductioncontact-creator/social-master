import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  authorizationServerMetadata,
  bearerToken,
  buildRedirect,
  isAcceptableRedirectUri,
  protectedResourceMetadata,
  randomToken,
  sha256Hex,
  verifyPkceS256,
} from "@/lib/mcp/oauth-core";

describe("PKCE S256", () => {
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"; // exemple RFC 7636 annexe B
  const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

  it("accepte le couple verifier/challenge de la RFC 7636", () => {
    expect(verifyPkceS256(verifier, challenge)).toBe(true);
  });

  it("refuse un verifier différent, trop court ou avec des caractères interdits", () => {
    expect(verifyPkceS256(verifier.slice(0, -1) + "x", challenge)).toBe(false);
    expect(verifyPkceS256("court", createHash("sha256").update("court").digest("base64url"))).toBe(false);
    const bad = "a".repeat(42) + "!";
    expect(verifyPkceS256(bad, createHash("sha256").update(bad).digest("base64url"))).toBe(false);
  });
});

describe("URI de redirection", () => {
  it("accepte https (claude.ai) et http en boucle locale (clients natifs)", () => {
    expect(isAcceptableRedirectUri("https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(isAcceptableRedirectUri("http://localhost:6274/oauth/callback")).toBe(true);
    expect(isAcceptableRedirectUri("http://127.0.0.1:33418/callback")).toBe(true);
  });

  it("refuse http distant, schémas exotiques, fragments et chaînes invalides", () => {
    expect(isAcceptableRedirectUri("http://evil.example/callback")).toBe(false);
    expect(isAcceptableRedirectUri("javascript:alert(1)")).toBe(false);
    expect(isAcceptableRedirectUri("https://claude.ai/cb#frag")).toBe(false);
    expect(isAcceptableRedirectUri("pas une url")).toBe(false);
  });

  it("buildRedirect conserve la requête existante et n'ajoute que les paramètres définis", () => {
    const url = new URL(buildRedirect("https://claude.ai/cb?x=1", { code: "abc", state: undefined }));
    expect(url.searchParams.get("x")).toBe("1");
    expect(url.searchParams.get("code")).toBe("abc");
    expect(url.searchParams.has("state")).toBe(false);
  });
});

describe("métadonnées de découverte", () => {
  const issuer = "https://social-master-jitq.onrender.com";

  it("serveur d'autorisation (RFC 8414) : code + PKCE S256, DCR, refresh", () => {
    const m = authorizationServerMetadata(issuer);
    expect(m.issuer).toBe(issuer);
    expect(m.authorization_endpoint).toBe(`${issuer}/oauth/authorize`);
    expect(m.token_endpoint).toBe(`${issuer}/api/oauth/mcp/token`);
    expect(m.registration_endpoint).toBe(`${issuer}/api/oauth/mcp/register`);
    expect(m.code_challenge_methods_supported).toEqual(["S256"]);
    expect(m.grant_types_supported).toContain("refresh_token");
  });

  it("ressource protégée (RFC 9728) : l'endpoint MCP et son serveur d'autorisation", () => {
    const m = protectedResourceMetadata(issuer);
    expect(m.resource).toBe(`${issuer}/api/mcp`);
    expect(m.authorization_servers).toEqual([issuer]);
  });
});

describe("jetons", () => {
  it("randomToken produit des secrets base64url distincts et suffisamment longs", () => {
    const a = randomToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(a);
  });

  it("sha256Hex est déterministe et ne révèle pas le secret", () => {
    expect(sha256Hex("secret")).toBe(sha256Hex("secret"));
    expect(sha256Hex("secret")).toHaveLength(64);
    expect(sha256Hex("secret")).not.toContain("secret");
  });

  it("bearerToken extrait le jeton d'un en-tête Authorization Bearer", () => {
    expect(bearerToken("Bearer abc.DEF-123")).toBe("abc.DEF-123");
    expect(bearerToken("bearer xyz")).toBe("xyz");
    expect(bearerToken("Basic abc")).toBeNull();
    expect(bearerToken(null)).toBeNull();
  });
});
