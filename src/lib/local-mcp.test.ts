import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { allowedRoots, authorizeUrl, isInsideRoots, mediaKind, pkcePair, sizeHints } from "../../local-mcp/lib.mjs";

// Outil d'envoi depuis le Mac (local-mcp/, CLAUDE.md §31) : garde-fous de sécurité et formats.
describe("local-mcp : dossiers autorisés", () => {
  it("par défaut : Téléchargements, Bureau, Vidéos, Images du dossier personnel", () => {
    expect(allowedRoots("/Users/moha")).toEqual({
      "Téléchargements": "/Users/moha/Downloads",
      Bureau: "/Users/moha/Desktop",
      "Vidéos": "/Users/moha/Movies",
      Images: "/Users/moha/Pictures",
    });
    expect(allowedRoots("/Users/moha", "Test=/tmp/x")).toEqual({ Test: "/tmp/x" });
  });

  it("n'accepte que les fichiers DANS un dossier autorisé (pas de préfixe trompeur ni de sortie)", () => {
    const roots = ["/Users/moha/Downloads", "/Users/moha/Pictures"];
    expect(isInsideRoots("/Users/moha/Downloads/clip.mp4", roots)).toBe(true);
    expect(isInsideRoots("/Users/moha/Downloads/sous/dossier/clip.mov", roots)).toBe(true);
    expect(isInsideRoots("/Users/moha/Downloads-secret/clip.mp4", roots)).toBe(false);
    expect(isInsideRoots("/Users/moha/.ssh/id_ed25519", roots)).toBe(false);
    expect(isInsideRoots("/etc/passwd", roots)).toBe(false);
  });
});

describe("local-mcp : formats", () => {
  it("médias acceptés (casse ignorée), HEIC à convertir, le reste refusé", () => {
    expect(mediaKind("/a/IMG_0001.MOV")).toEqual({ mime: "video/quicktime" });
    expect(mediaKind("/a/clip.m4v")).toEqual({ mime: "video/mp4" });
    expect(mediaKind("/a/photo.JPEG")).toEqual({ mime: "image/jpeg" });
    expect(mediaKind("/a/IMG_0002.HEIC")).toEqual({ convert: true });
    expect(mediaKind("/a/notes.pdf")).toBeNull();
    expect(mediaKind("/a/id_rsa")).toBeNull();
  });

  it("conseils de taille : Reel Instagram > 300 Mo, photo Instagram > 8 Mo", () => {
    expect(sizeHints("video/mp4", 400 * 1024 * 1024)).toHaveLength(1);
    expect(sizeHints("video/mp4", 120 * 1024 * 1024)).toEqual([]);
    expect(sizeHints("image/jpeg", 9 * 1024 * 1024)).toHaveLength(1);
  });
});

describe("local-mcp : OAuth", () => {
  it("PKCE S256 cohérent et URL d'autorisation complète", () => {
    const { verifier, challenge } = pkcePair();
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(challenge);
    const url = new URL(authorizeUrl("https://app.test", { clientId: "c1", redirectUri: "http://127.0.0.1:5000/callback", challenge, state: "s" }));
    expect(url.pathname).toBe("/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: "code",
      client_id: "c1",
      redirect_uri: "http://127.0.0.1:5000/callback",
      code_challenge_method: "S256",
      state: "s",
    });
  });
});
