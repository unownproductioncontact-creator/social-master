#!/usr/bin/env node
// Construit l'extension Claude bureau (.mcpb) qui branche le serveur MCP local — CLAUDE.md §31.
//
// Pourquoi une extension : Claude bureau réécrit claude_desktop_config.json avec la copie qu'il garde en
// mémoire, ce qui efface une entrée « mcpServers » ajoutée app ouverte (constaté le 01/10 et le 05/10/2026).
// Les extensions sont stockées à part par l'app et survivent à ces réécritures.
//
// Extension « mince » : elle ne contient qu'un chargeur qui importe le serveur du dépôt (chemin absolu
// figé à la construction), donc toute mise à jour du dépôt s'applique sans réinstaller. Ses dépendances
// (SDK MCP, zod) restent celles de ~/social-master/node_modules.
//
// Usage : node build-extension.mjs [sortie.mcpb]   puis double-cliquer le fichier → Claude bureau → Installer.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const server = path.join(here, "social-master-local.mjs");
const output = path.resolve(process.argv[2] || path.join(here, "dist", "social-master-local.mcpb"));

const manifest = {
  manifest_version: "0.3",
  name: "social-master-local",
  display_name: "Social Master — envoi depuis le Mac",
  version: "1.1.0",
  description: "Envoie des photos et vidéos du Mac vers la médiathèque Social Master (dossiers autorisés seulement).",
  long_description:
    "Outils : connect_social_master, list_local_media, upload_local_media, get_upload_status. Dossiers autorisés : Téléchargements, Bureau, Vidéos, Images et ceux de ~/.social-master/config.json. Le fichier part directement vers le stockage via une URL présignée ; utiliser ensuite le media_id avec le connecteur Social Master.",
  author: { name: "Pokemoha" },
  server: {
    type: "node",
    entry_point: "server/index.mjs",
    mcp_config: {
      command: "node",
      args: ["${__dirname}/server/index.mjs"],
      env: { SOCIAL_MASTER_SERVER: server },
    },
  },
  tools: [
    { name: "connect_social_master", description: "Vérifie la connexion au compte Social Master (navigateur la première fois)." },
    { name: "list_local_media", description: "Liste les photos et vidéos d'un dossier autorisé du Mac." },
    { name: "upload_local_media", description: "Envoie une photo ou une vidéo du Mac vers la médiathèque Social Master." },
    { name: "get_upload_status", description: "Avancement d'un envoi (uploading, done + media_id, failed)." },
  ],
  compatibility: { platforms: ["darwin"], runtimes: { node: ">=20.0.0" } },
};

const loader = `// Chargeur de l'extension Claude bureau : importe le serveur MCP local du dépôt Social Master.
import { pathToFileURL } from "node:url";
await import(pathToFileURL(process.env.SOCIAL_MASTER_SERVER).href);
`;

const stage = mkdtempSync(path.join(tmpdir(), "social-master-mcpb-"));
try {
  mkdirSync(path.join(stage, "server"));
  writeFileSync(path.join(stage, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(path.join(stage, "server", "index.mjs"), loader);
  mkdirSync(path.dirname(output), { recursive: true });
  rmSync(output, { force: true });
  execFileSync("zip", ["-q", "-r", "-X", output, "manifest.json", "server"], { cwd: stage });
  console.log(`Extension prête : ${output}`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
