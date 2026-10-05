#!/usr/bin/env node
// Social Master — envoi de médias DEPUIS LE MAC (serveur MCP local, stdio) — CLAUDE.md §31.
//
// Branché dans l'app Claude de bureau (extension, build-extension.mjs) et dans Claude Code, il complète
// le connecteur distant : celui-ci ne peut pas lire tes fichiers, ce serveur-ci le peut, mais UNIQUEMENT
// dans les dossiers autorisés (Téléchargements, Bureau, Vidéos, Images + ceux de
// ~/.social-master/config.json) et uniquement des médias. Cœur commun avec la ligne de commande
// sm-upload.mjs : client.mjs. Le fichier part directement vers le stockage R2 via une
// URL présignée (même circuit que la médiathèque web) ; Claude utilise ensuite le media_id avec le
// connecteur Social Master (save_draft, schedule_post…).
//
// Connexion : une seule fois, par le même écran « Autoriser » que le connecteur (OAuth + PKCE, retour
// sur 127.0.0.1). Jetons gardés dans ~/.social-master/credentials.json (lisible par toi seul).
// Rien n'est écrit sur stdout hors protocole MCP : journaux sur stderr.

import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import * as z from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BASE, NeedLoginError, ROOTS, accessToken, log, resolveMediaPath, startLogin, uploadMedia, whoAmI } from "./client.mjs";
import { mediaKind } from "./lib.mjs";

// ---------------------------------------------------------------- envois (en arrière-plan, suivis par upload_id)

const uploads = new Map(); // upload_id → état

async function runUpload(job) {
  try {
    const { name, media, hints } = await uploadMedia(job.file, {
      progress: {
        onStart: (sentName, size) => {
          job.name = sentName;
          job.size = size;
        },
        onBytes: (sent) => {
          job.sent = sent;
        },
      },
    });
    job.name = name;
    job.result = media;
    job.hints = hints;
    job.status = "done";
  } catch (err) {
    job.status = "failed";
    job.error = err instanceof NeedLoginError ? `${err.message} Appelle connect_social_master.` : err.message;
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
      `Envoie une photo ou une vidéo du Mac (dossiers autorisés : ${Object.keys(ROOTS).join(", ")}) vers la médiathèque Social Master. Formats : MP4, MOV, M4V, WebM, JPEG, PNG, WebP, HEIC (converti en JPEG) ; 2 Go max. Renvoie le media_id quand c'est fini, sinon un upload_id à suivre avec get_upload_status.`,
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
