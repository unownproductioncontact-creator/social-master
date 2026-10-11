import { createHmac } from "node:crypto";

/**
 * Liens signés vers le Worker Cloudflare des médias (CLAUDE.md §36) — même schéma que
 * cloudflare/media-worker/src/index.js : `${base}/m/<clé>?exp=<epoch s>&sig=<hex>` avec
 * sig = HMAC-SHA256("<clé>\n<exp>", secret).
 *
 * L'expiration est arrondie à une fenêtre de 12 h : le lien reste identique pendant la fenêtre (le
 * navigateur peut garder l'aperçu en cache) et vaut entre 12 et 24 h — largement assez pour que
 * Meta, TikTok ou le navigateur aillent chercher le fichier.
 */
export const SIGNED_URL_WINDOW_S = 12 * 3600;

export function signedMediaExpiry(nowMs: number): number {
  const window = Math.floor(nowMs / 1000 / SIGNED_URL_WINDOW_S);
  return (window + 2) * SIGNED_URL_WINDOW_S;
}

export function signMediaKey(secret: string, key: string, exp: number): string {
  return createHmac("sha256", secret).update(`${key}\n${exp}`).digest("hex");
}

export function signedWorkerMediaUrl(baseUrl: string, secret: string, key: string, nowMs = Date.now()): string {
  const exp = signedMediaExpiry(nowMs);
  const path = key.split("/").map(encodeURIComponent).join("/");
  return `${baseUrl.replace(/\/+$/, "")}/m/${path}?exp=${exp}&sig=${signMediaKey(secret, key, exp)}`;
}
