#!/usr/bin/env node
// Social Master — envoi de médias DEPUIS LE MAC (serveur MCP local, stdio) — CLAUDE.md §31.
//
// Branché dans l'app Claude de bureau (et Claude Code), il complète le connecteur distant : celui-ci ne
// peut pas lire tes fichiers, ce serveur-ci le peut, mais UNIQUEMENT dans Téléchargements, Bureau,
// Vidéos et Images, et uniquement des médias. Le fichier part directement vers le stockage R2 via une
// URL présignée (même circuit que la médiathèque web) ; Claude utilise ensuite le media_id avec le
// connecteur Social Master (save_draft, schedule_post…).
//
// Connexion : une seule fois, par le même écran « Autoriser » que le connecteur (OAuth + PKCE, retour
// sur 127.0.0.1). Jetons gardés dans ~/.social-master/credentials.json (lisible par toi seul).
// Rien n'est écrit sur stdout hors protocole MCP : journaux sur stderr.

import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { chmod, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { Transform } from "node:stream";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import * as z from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { allowedRoots, authorizeUrl, isInsideRoots, mediaKind, pkcePair, sizeHints } from "./lib.mjs";

const run = promisify(execFile);
const BASE = (process.env.SOCIAL_MASTER_URL || "https://social-master-jitq.onrender.com").replace(/\/+$/, "");
const HOME_DIR = process.env.SOCIAL_MASTER_HOME || path.join(homedir(), ".social-master");
const CREDENTIALS = path.join(HOME_DIR, "credentials.json");
const NO_BROWSER = process.env.SOCIAL_MASTER_NO_BROWSER === "1";
const ROOTS = allowedRoots(homedir(), process.env.SOCIAL_MASTER_ROOTS);
const MAX_UPLOAD_BYTES = 2_000_000_000;

const log = (...args) => console.error("[social-master-local]", ...args);

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

class NeedLoginError extends Error {}

/** Jeton d'accès valide (rafraîchi si besoin) ; NeedLoginError si une connexion est nécessaire. */
async function accessToken({ forceRefresh = false } = {}) {
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
async function api(pathname, init = {}) {
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

let pendingLogin = null; // { url, promise }

function startLogin() {
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

async function whoAmI() {
  const me = await api("/api/mcp/me");
  return me.email;
}

// ---------------------------------------------------------------- envois

const uploads = new Map(); // upload_id → état

async function resolveMediaPath(input) {
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

async function runUpload(job) {
  let tmpFile = null;
  try {
    let file = job.file;
    let kind = mediaKind(file);
    if (kind?.convert) {
      // Photo iPhone (HEIC) : conversion JPEG locale avec l'outil macOS « sips ».
      tmpFile = path.join(tmpdir(), `social-master-${randomBytes(6).toString("hex")}.jpg`);
      await run("sips", ["-s", "format", "jpeg", file, "--out", tmpFile]);
      file = tmpFile;
      kind = { mime: "image/jpeg" };
      job.name = job.name.replace(/\.(heic|heif)$/i, ".jpg");
    }
    const size = (await stat(file)).size;
    job.size = size;
    if (size > MAX_UPLOAD_BYTES) throw new Error("Fichier trop volumineux (2 Go maximum).");

    const presign = await api("/api/mcp/media/presign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileName: job.name, mimeType: kind.mime, sizeBytes: size }),
    });
    job.media_id = presign.media_id;

    const counter = new Transform({
      transform(chunk, _enc, cb) {
        job.sent += chunk.length;
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

    job.result = await api(`/api/mcp/media/${presign.media_id}/complete`, { method: "POST" });
    job.status = "done";
    job.hints = sizeHints(kind.mime, size);
  } catch (err) {
    job.status = "failed";
    job.error = err instanceof NeedLoginError ? `${err.message} Appelle connect_social_master.` : err.message;
  } finally {
    if (tmpFile) await rm(tmpFile, { force: true });
  }
}

function describeJob(job) {
  if (job.status === "done") {
    return { upload_id: job.id, status: "done", file: job.name, ...job.result, hints: job.hints?.length ? job.hints : undefined, next: "Utiliser ce media_id avec le connecteur Social Master (save_draft)." };
  }
  if (job.status === "failed") return { upload_id: job.id, status: "failed", file: job.name, error: job.error };
  const percent = job.size ? Math.min(99, Math.floor((job.sent / job.size) * 100)) : 0;
  return { upload_id: job.id, status: "uploading", file: job.name, progress: `${percent} %`, next: "Rappeler get_upload_status dans quelques secondes." };
}

// ---------------------------------------------------------------- serveur MCP

const text = (data) => ({ content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] });
const failure = (message) => ({ content: [{ type: "text", text: `Erreur : ${message}` }], isError: true });

const server = new McpServer(
  { name: "social-master-local", version: "1.0.0" },
  {
    instructions:
      "Envoie des photos/vidéos du Mac vers la médiathèque Social Master. 1) list_local_media pour trouver le fichier, 2) upload_local_media, 3) get_upload_status jusqu'à « done », 4) utiliser le media_id avec le connecteur Social Master (save_draft puis schedule_post / publish_post_now). Si une connexion est demandée : connect_social_master, l'utilisateur clique « Autoriser » dans son navigateur.",
  }
);

server.registerTool(
  "connect_social_master",
  {
    title: "Connecter Social Master",
    description: "Vérifie la connexion au compte Social Master ; la première fois, ouvre le navigateur sur l'écran « Autoriser » (une seule fois).",
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  async () => {
    try {
      return text(`Connecté à Social Master (${await whoAmI()}).`);
    } catch (err) {
      if (!(err instanceof NeedLoginError)) return failure(err.message);
    }
    const login = startLogin();
    const url = await login.urlReady;
    const outcome = await Promise.race([
      login.promise.then(() => "ok", (e) => e),
      new Promise((r) => setTimeout(() => r("pending"), 45_000)),
    ]);
    if (outcome === "ok") return text(`Connecté à Social Master (${await whoAmI()}).`);
    if (outcome instanceof Error) return failure(outcome.message);
    return text(`En attente d'autorisation : clique « Autoriser » dans le navigateur (lien : ${url}), puis rappelle connect_social_master.`);
  }
);

server.registerTool(
  "list_local_media",
  {
    title: "Lister mes médias sur le Mac",
    description: "Liste les photos et vidéos d'un dossier autorisé du Mac, des plus récentes aux plus anciennes, avec leur chemin à passer à upload_local_media.",
    inputSchema: {
      dossier: z.enum(Object.keys(ROOTS)).default(Object.keys(ROOTS)[0]).describe("Dossier à parcourir"),
      limit: z.number().int().min(1).max(100).default(20),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ dossier, limit }) => {
    const dir = ROOTS[dossier];
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return failure(`Dossier inaccessible : ${dir}`);
    }
    const files = [];
    for (const e of entries) {
      if (!e.isFile() || !mediaKind(e.name)) continue;
      const full = path.join(dir, e.name);
      const s = await stat(full).catch(() => null);
      if (s) files.push({ name: e.name, path: full, size_mb: Math.round((s.size / (1024 * 1024)) * 10) / 10, modified: s.mtime });
    }
    files.sort((a, b) => b.modified - a.modified);
    return text(
      files.slice(0, limit).map((f) => ({ ...f, modified: f.modified.toISOString().slice(0, 16).replace("T", " ") }))
    );
  }
);

server.registerTool(
  "upload_local_media",
  {
    title: "Envoyer un média du Mac",
    description:
      "Envoie une photo ou une vidéo du Mac (Téléchargements, Bureau, Vidéos, Images) vers la médiathèque Social Master. Formats : MP4, MOV, M4V, WebM, JPEG, PNG, WebP, HEIC (converti en JPEG) ; 2 Go max. Renvoie le media_id quand c'est fini, sinon un upload_id à suivre avec get_upload_status.",
    inputSchema: { path: z.string().min(1).describe("Chemin du fichier (tel que donné par list_local_media)") },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ path: input }) => {
    let file;
    try {
      file = await resolveMediaPath(input);
    } catch (err) {
      return failure(err.message);
    }
    if (!mediaKind(file)) return failure("Format non supporté : MP4, MOV, M4V, WebM, JPEG, PNG, WebP ou HEIC.");
    try {
      await accessToken();
    } catch (err) {
      if (err instanceof NeedLoginError) return failure(`${err.message} Appelle d'abord connect_social_master.`);
      return failure(err.message);
    }
    const job = { id: randomBytes(6).toString("hex"), file, name: path.basename(file), status: "uploading", sent: 0, size: 0 };
    uploads.set(job.id, job);
    const done = runUpload(job);
    await Promise.race([done, new Promise((r) => setTimeout(r, 25_000))]);
    return text(describeJob(job));
  }
);

server.registerTool(
  "get_upload_status",
  {
    title: "Suivre un envoi",
    description: "Avancement d'un envoi lancé par upload_local_media (uploading + %, done + media_id, ou failed + raison).",
    inputSchema: { upload_id: z.string().min(1) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ upload_id }) => {
    const job = uploads.get(upload_id);
    return job ? text(describeJob(job)) : failure("Envoi inconnu (le serveur local a peut-être redémarré).");
  }
);

await server.connect(new StdioServerTransport());
log(`prêt (${BASE})`);
