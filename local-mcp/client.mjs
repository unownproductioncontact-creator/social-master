// Social Master — cœur de l'envoi DEPUIS LE MAC (CLAUDE.md §31), partagé par le serveur MCP local
// (social-master-local.mjs) et la ligne de commande (sm-upload.mjs) : jetons OAuth, connexion par le
// navigateur, dossiers autorisés et envoi direct vers R2 via une URL présignée (même circuit que la
// médiathèque web). Rien n'est écrit sur stdout (réservé au protocole MCP) : journaux sur stderr.

import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { createReadStream, readFileSync } from "node:fs";
import { chmod, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { Transform } from "node:stream";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { allowedRoots, authorizeUrl, extraRootsFrom, isInsideRoots, mediaKind, pkcePair, sizeHints } from "./lib.mjs";

const run = promisify(execFile);
export const BASE = (process.env.SOCIAL_MASTER_URL || "https://social-master-jitq.onrender.com").replace(/\/+$/, "");
const HOME_DIR = process.env.SOCIAL_MASTER_HOME || path.join(homedir(), ".social-master");
const CREDENTIALS = path.join(HOME_DIR, "credentials.json");
const NO_BROWSER = process.env.SOCIAL_MASTER_NO_BROWSER === "1";
const MAX_UPLOAD_BYTES = 2_000_000_000;

/** Dossiers ajoutés dans ~/.social-master/config.json ({ "roots": { "Nom": "/chemin" } }) — aucun si absent. */
function readExtraRoots() {
  try {
    return extraRootsFrom(JSON.parse(readFileSync(path.join(HOME_DIR, "config.json"), "utf8")));
  } catch {
    return {};
  }
}

export const ROOTS = allowedRoots(homedir(), process.env.SOCIAL_MASTER_ROOTS, readExtraRoots());

export const log = (...args) => console.error("[social-master-local]", ...args);

// ---------------------------------------------------------------- jetons OAuth

async function loadCredentials() {
  try {
    const creds = JSON.parse(await readFile(CREDENTIALS, "utf8"));
    return creds.base === BASE ? creds : null;
  } catch {
    return null;
  }
}

async function saveCredentials(creds) {
  await mkdir(HOME_DIR, { recursive: true, mode: 0o700 });
  await writeFile(CREDENTIALS, JSON.stringify(creds, null, 2), { mode: 0o600 });
  await chmod(CREDENTIALS, 0o600);
}

async function tokenRequest(params) {
  const res = await fetch(`${BASE}/api/oauth/mcp/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error_description || body.error || `HTTP ${res.status}`);
  return body;
}

async function storeTokens(clientId, tokens) {
  const creds = {
    base: BASE,
    client_id: clientId,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: Date.now() + tokens.expires_in * 1000,
  };
  await saveCredentials(creds);
  return creds;
}

export class NeedLoginError extends Error {}

/** Jeton d'accès valide (rafraîchi si besoin) ; NeedLoginError si une connexion est nécessaire. */
export async function accessToken({ forceRefresh = false } = {}) {
  const creds = await loadCredentials();
  if (!creds) throw new NeedLoginError("Pas encore connecté à Social Master.");
  if (!forceRefresh && creds.expires_at - 60_000 > Date.now()) return creds.access_token;
  try {
    const tokens = await tokenRequest({ grant_type: "refresh_token", refresh_token: creds.refresh_token, client_id: creds.client_id });
    return (await storeTokens(creds.client_id, tokens)).access_token;
  } catch (err) {
    await rm(CREDENTIALS, { force: true });
    throw new NeedLoginError(`Connexion expirée ou révoquée (${err.message}).`);
  }
}

/** Appel authentifié à l'API Social Master, avec un rafraîchissement + nouvel essai sur 401. */
export async function api(pathname, init = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await accessToken({ forceRefresh: attempt === 1 });
    const res = await fetch(`${BASE}${pathname}`, {
      ...init,
      headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` },
    });
    if (res.status === 401 && attempt === 0) continue;
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error_description || body.error || `HTTP ${res.status}`);
    return body;
  }
  throw new NeedLoginError("Accès refusé par Social Master.");
}

// ---------------------------------------------------------------- connexion (navigateur, une fois)

let pendingLogin = null; // { urlReady, promise }

export function startLogin() {
  if (pendingLogin) return pendingLogin;
  let resolveUrl;
  const urlReady = new Promise((r) => (resolveUrl = r));
  const promise = (async () => {
    const { verifier, challenge } = pkcePair();
    const state = randomBytes(16).toString("base64url");
    let settle;
    const codePromise = new Promise((resolve, reject) => (settle = { resolve, reject }));
    const http = createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const ok = url.searchParams.get("state") === state && url.searchParams.get("code");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        ok
          ? "<p style='font-family:sans-serif'>Social Master est connecté à Claude. Tu peux fermer cet onglet.</p>"
          : "<p style='font-family:sans-serif'>Autorisation refusée ou invalide.</p>"
      );
      if (ok) settle.resolve(url.searchParams.get("code"));
      else settle.reject(new Error(url.searchParams.get("error") === "access_denied" ? "Autorisation refusée." : "Réponse d'autorisation invalide."));
    });
    await new Promise((r) => http.listen(0, "127.0.0.1", r));
    const redirectUri = `http://127.0.0.1:${http.address().port}/callback`;
    try {
      const reg = await fetch(`${BASE}/api/oauth/mcp/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_name: "Envoi depuis le Mac", redirect_uris: [redirectUri], token_endpoint_auth_method: "none" }),
      });
      const client = await reg.json();
      if (!reg.ok) throw new Error(client.error_description || client.error || `HTTP ${reg.status}`);
      const url = authorizeUrl(BASE, { clientId: client.client_id, redirectUri, challenge, state });
      resolveUrl(url);
      log("Autorisation :", url);
      if (!NO_BROWSER) execFile("open", [url], () => {});
      const timeout = setTimeout(() => settle.reject(new Error("Délai d'autorisation dépassé (5 min).")), 5 * 60_000);
      const code = await codePromise.finally(() => clearTimeout(timeout));
      const tokens = await tokenRequest({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: client.client_id,
        code_verifier: verifier,
      });
      await storeTokens(client.client_id, tokens);
    } finally {
      http.close();
    }
  })();
  pendingLogin = { urlReady, promise };
  promise.finally(() => {
    pendingLogin = null;
  }).catch(() => {});
  return pendingLogin;
}

export async function whoAmI() {
  const me = await api("/api/mcp/me");
  return me.email;
}

// ---------------------------------------------------------------- envois

/** Chemin RÉEL (liens résolus) d'un fichier, obligatoirement dans un dossier autorisé. */
export async function resolveMediaPath(input) {
  const expanded = input.startsWith("~") ? path.join(homedir(), input.slice(1)) : input;
  let real;
  try {
    real = await realpath(path.resolve(expanded));
  } catch {
    throw new Error(`Fichier introuvable : ${input}`);
  }
  const realRoots = await Promise.all(Object.values(ROOTS).map((r) => realpath(r).catch(() => r)));
  if (!isInsideRoots(real, realRoots)) {
    throw new Error(`Accès refusé : seuls les fichiers de ${Object.keys(ROOTS).join(", ")} peuvent être envoyés.`);
  }
  return real;
}

/**
 * Envoie un fichier (déjà passé par resolveMediaPath) vers la médiathèque : conversion JPEG locale par
 * l'outil macOS « sips » pour le HEIC (toujours) et le PNG/WebP (si `toJpeg`), puis presign → PUT direct
 * sur R2 → complete. `progress.onStart(nom, taille)` et `progress.onBytes(envoyés)` suivent l'envoi.
 * Renvoie { name, media, hints } — `media` = réponse de /complete (media_id, status, kind, dimensions…).
 */
export async function uploadMedia(file, { toJpeg = false, progress = {} } = {}) {
  let tmpFile = null;
  let name = path.basename(file);
  try {
    let kind = mediaKind(file);
    if (!kind) throw new Error("Format non supporté : MP4, MOV, M4V, WebM, JPEG, PNG, WebP ou HEIC.");
    if (kind.convert || (toJpeg && (kind.mime === "image/png" || kind.mime === "image/webp"))) {
      tmpFile = path.join(tmpdir(), `social-master-${randomBytes(6).toString("hex")}.jpg`);
      await run("sips", ["-s", "format", "jpeg", file, "--out", tmpFile]);
      file = tmpFile;
      kind = { mime: "image/jpeg" };
      name = name.replace(/\.(heic|heif|png|webp)$/i, ".jpg");
    }
    const size = (await stat(file)).size;
    progress.onStart?.(name, size);
    if (size > MAX_UPLOAD_BYTES) throw new Error("Fichier trop volumineux (2 Go maximum).");

    const presign = await api("/api/mcp/media/presign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileName: name, mimeType: kind.mime, sizeBytes: size }),
    });

    let sent = 0;
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        sent += chunk.length;
        progress.onBytes?.(sent);
        cb(null, chunk);
      },
    });
    const put = await fetch(presign.upload_url, {
      method: "PUT",
      headers: { "Content-Type": kind.mime, "Content-Length": String(size) },
      body: createReadStream(file).pipe(counter),
      duplex: "half",
    });
    if (!put.ok) throw new Error(`Envoi vers le stockage refusé (HTTP ${put.status}).`);

    const media = await api(`/api/mcp/media/${presign.media_id}/complete`, { method: "POST" });
    return { name, media, hints: sizeHints(kind.mime, size) };
  } finally {
    if (tmpFile) await rm(tmpFile, { force: true });
  }
}
