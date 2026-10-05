#!/usr/bin/env node
// Social Master — envoi de fichiers du Mac vers la médiathèque EN LIGNE DE COMMANDE (CLAUDE.md §31).
//
// Même circuit que le serveur MCP local (cœur commun client.mjs) : jetons de ~/.social-master,
// dossiers autorisés seulement, URL présignée vers R2. Marche depuis n'importe quel terminal ou
// conversation Claude Code, que le serveur MCP soit branché ou non. N'affiche jamais de jeton.
//
//   node sm-upload.mjs [--jpeg] [--json] <fichier…>   envoie dans l'ordre donné (carrousel = ordre des slides)
//   node sm-upload.mjs --login                         connexion seule (navigateur, une fois)
//   node sm-upload.mjs --roots                         dossiers autorisés
//
// --jpeg : convertit PNG/WebP en JPEG avant l'envoi (TikTok n'accepte que JPEG/WebP en photo).
// Sortie : une ligne « media_id<TAB>fichier<TAB>type<TAB>dimensions » par fichier envoyé, puis
// « media_ids: … » dans l'ordre ; --json : un tableau JSON à la place. Code de sortie 1 au premier échec.

import { NeedLoginError, ROOTS, resolveMediaPath, startLogin, uploadMedia, whoAmI } from "./client.mjs";
import { mediaKind } from "./lib.mjs";

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const files = args.filter((a) => !a.startsWith("--"));
const say = (line) => process.stdout.write(`${line}\n`);
const note = (line) => process.stderr.write(`${line}\n`);

/** Vérifie la connexion ; la première fois (ou si révoquée), ouvre le navigateur sur « Autoriser ». */
async function ensureLogin() {
  try {
    return await whoAmI();
  } catch (err) {
    if (!(err instanceof NeedLoginError)) throw err;
    note(`${err.message} Ouverture du navigateur : clique « Autoriser » (5 min max).`);
    const login = startLogin();
    note(`Lien : ${await login.urlReady}`);
    await login.promise;
    return await whoAmI();
  }
}

async function main() {
  const unknown = [...flags].filter((f) => !["--jpeg", "--json", "--login", "--roots"].includes(f));
  if (unknown.length || (!files.length && !flags.has("--login") && !flags.has("--roots"))) {
    note("Usage : node sm-upload.mjs [--jpeg] [--json] <fichier…> | --login | --roots");
    return 2;
  }
  if (flags.has("--roots")) {
    for (const [name, dir] of Object.entries(ROOTS)) say(`${name}\t${dir}`);
    if (!files.length && !flags.has("--login")) return 0;
  }

  // Tous les fichiers sont vérifiés AVANT le premier envoi : un carrousel part entier ou pas du tout.
  const resolved = [];
  for (const input of files) {
    const file = await resolveMediaPath(input);
    if (!mediaKind(file)) throw new Error(`Format non supporté (${input}) : MP4, MOV, M4V, WebM, JPEG, PNG, WebP ou HEIC.`);
    resolved.push(file);
  }

  note(`Connecté à Social Master (${await ensureLogin()}).`);
  if (!resolved.length) return 0;

  const sent = [];
  for (const file of resolved) {
    let total = 0;
    let shown = 0;
    try {
      const { name, media, hints } = await uploadMedia(file, {
        toJpeg: flags.has("--jpeg"),
        progress: {
          onStart: (n, size) => {
            total = size;
            note(`Envoi de ${n} (${(size / (1024 * 1024)).toFixed(1)} Mo)…`);
          },
          onBytes: (bytes) => {
            const pct = Math.floor((bytes / total) * 10) * 10;
            if (total > 20 * 1024 * 1024 && pct > shown) note(`  ${(shown = pct)} %`);
          },
        },
      });
      for (const hint of hints) note(`  ⚠ ${hint}`);
      sent.push({ file: name, ...media });
      if (!flags.has("--json")) {
        const dims = media.width && media.height ? `${media.width}x${media.height}` : "?";
        say(`${media.media_id}\t${name}\t${media.kind}\t${dims}${media.duration_s ? `\t${media.duration_s} s` : ""}`);
      }
    } catch (err) {
      note(`Échec pour ${file} : ${err.message}`);
      if (sent.length) note(`Déjà envoyés (dans l'ordre) : ${sent.map((m) => m.media_id).join(" ")}`);
      return 1;
    }
  }
  if (flags.has("--json")) say(JSON.stringify(sent, null, 2));
  else say(`media_ids: ${sent.map((m) => m.media_id).join(" ")}`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    note(`Erreur : ${err.message}`);
    process.exit(1);
  }
);
