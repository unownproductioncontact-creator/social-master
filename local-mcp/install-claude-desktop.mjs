#!/usr/bin/env node
// Branche (ou met à jour) le serveur local « social-master-local » dans l'app Claude de bureau — CLAUDE.md §31.
//
// ⚠️ À lancer quand Claude bureau est FERMÉ : l'app lit claude_desktop_config.json au démarrage, le garde
// en mémoire et le réécrit tel quel (constaté le 04/10/2026 : l'entrée ajoutée app ouverte le 01/10
// avait disparu). Voir « Activer dans Claude bureau.command » qui attend la fermeture puis rouvre l'app.
//
// Usage : node install-claude-desktop.mjs ["Nom=/chemin/dossier" …]
// Sans argument : Téléchargements, Bureau, Vidéos, Images. Chaque argument AJOUTE un dossier autorisé.

import { copyFileSync, existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { allowedRoots } from "./lib.mjs";

const CONFIG = path.join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "social-master-local.mjs");

const extra = process.argv.slice(2).map((arg) => {
  const i = arg.indexOf("=");
  if (i < 1) throw new Error(`Argument invalide (attendu Nom=/chemin) : ${arg}`);
  const dir = arg.slice(i + 1);
  if (!existsSync(dir)) throw new Error(`Dossier introuvable : ${dir}`);
  // Chemin réel (forme stockée sur le disque, liens résolus) : c'est lui que le serveur compare.
  return [arg.slice(0, i), realpathSync(dir)];
});
const roots = { ...Object.fromEntries(extra), ...allowedRoots(homedir()) };
for (const [name, dir] of Object.entries(roots)) {
  if (/[;=]/.test(name) || dir.includes(";")) throw new Error(`Nom ou chemin inutilisable : ${name}`);
}

const config = existsSync(CONFIG) ? JSON.parse(readFileSync(CONFIG, "utf8")) : {};
if (existsSync(CONFIG)) copyFileSync(CONFIG, `${CONFIG}.bak-${new Date().toISOString().slice(0, 10)}`);
config.mcpServers = {
  ...config.mcpServers,
  "social-master-local": {
    command: process.execPath,
    args: [SERVER],
    env: { SOCIAL_MASTER_ROOTS: Object.entries(roots).map(([n, d]) => `${n}=${d}`).join(";") },
  },
};
writeFileSync(CONFIG, JSON.stringify(config, null, 2));
console.log(`social-master-local branché dans Claude bureau. Dossiers : ${Object.keys(roots).join(", ")}.`);
