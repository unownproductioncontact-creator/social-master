// Fonctions PURES de l'outil d'envoi depuis le Mac (CLAUDE.md §31) — testées dans src/lib/local-mcp.test.ts.
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";

/** Extensions acceptées → type MIME (mêmes formats que la médiathèque). HEIC/HEIF : converti en JPEG avant envoi. */
export const MEDIA_TYPES = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};
export const CONVERTIBLE_TO_JPEG = new Set([".heic", ".heif"]);

/** Dossiers autorisés (jamais d'autre fichier du Mac). `override` : "Nom=/chemin;Nom2=/chemin2" (tests). */
export function allowedRoots(home, override) {
  if (override) {
    return Object.fromEntries(
      override
        .split(";")
        .filter(Boolean)
        .map((pair) => {
          const [name, dir] = pair.split("=");
          return [name, path.resolve(dir)];
        })
    );
  }
  return {
    "Téléchargements": path.join(home, "Downloads"),
    Bureau: path.join(home, "Desktop"),
    "Vidéos": path.join(home, "Movies"),
    Images: path.join(home, "Pictures"),
  };
}

/** Vrai si `realFile` (chemin RÉEL, liens résolus) est à l'intérieur de l'un des dossiers autorisés (réels). */
export function isInsideRoots(realFile, realRoots) {
  return realRoots.some((root) => realFile === root || realFile.startsWith(root.endsWith(path.sep) ? root : root + path.sep));
}

/** Type d'envoi d'un fichier : { mime } accepté, { convert: true } (HEIC), ou null (refusé). */
export function mediaKind(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (MEDIA_TYPES[ext]) return { mime: MEDIA_TYPES[ext] };
  if (CONVERTIBLE_TO_JPEG.has(ext)) return { convert: true };
  return null;
}

export function pkcePair() {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function authorizeUrl(base, { clientId, redirectUri, challenge, state }) {
  const url = new URL("/oauth/authorize", base);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    scope: "social-master",
  }).toString();
  return url.toString();
}

/** Conseils de compatibilité selon la taille (limites vérifiées : Reel Instagram 300 Mo, photo Instagram 8 Mo). */
export function sizeHints(mime, sizeBytes) {
  const mb = sizeBytes / (1024 * 1024);
  if (mime.startsWith("video/") && mb > 300) return ["Trop lourde pour un Reel Instagram (300 Mo max) : OK pour TikTok et YouTube."];
  if (mime.startsWith("image/") && mb > 8) return ["Trop lourde pour une photo Instagram (8 Mo max)."];
  return [];
}
