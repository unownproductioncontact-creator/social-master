#!/usr/bin/env node
// Social Master — attend que la vidéo YouTube d'un post soit chez YouTube ET traitée, puis affiche son
// identifiant (une ligne sur stdout). Sert à l'agent `miniature-studio` (CLAUDE.md §37) : après une
// programmation, la vidéo part tout de suite chez YouTube en privé (§38) ; Studio n'accepte la miniature
// qu'une fois la vidéo traitée. Jetons : ceux du client local (~/.social-master/credentials.json),
// jamais affichés.
//
// Usage : node sm-youtube-id.mjs <post_id> [--timeout <secondes, défaut 900>]
// Codes de sortie : 0 = identifiant affiché ; 2 = cible YouTube en échec ou absente ; 3 = délai dépassé ;
// 4 = connexion à Social Master requise (lancer sm-upload.mjs --login).

import { accessToken, BASE, NeedLoginError } from "./client.mjs";

const args = process.argv.slice(2);
const postId = args.find((a) => !a.startsWith("--"));
const timeoutIndex = args.indexOf("--timeout");
const timeoutMs = (timeoutIndex >= 0 ? Number(args[timeoutIndex + 1]) : 900) * 1000;
if (!postId || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  console.error("Usage : node sm-youtube-id.mjs <post_id> [--timeout <secondes>]");
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Appelle l'outil get_post du connecteur (même serveur MCP que Claude). */
async function getPost() {
  const token = await accessToken();
  const res = await fetch(`${BASE}/api/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_post", arguments: { post_id: postId } } }),
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 401) throw new NeedLoginError("Jeton refusé.");
  const json = await res.json();
  const text = json?.result?.content?.[0]?.text ?? "";
  if (json?.result?.isError) throw new Error(text || "get_post en erreur");
  return JSON.parse(text);
}

const deadline = Date.now() + timeoutMs;
let last = "";
for (;;) {
  try {
    const post = await getPost();
    const target = (post.targets ?? []).find((t) => t.platform === "YOUTUBE");
    if (!target) {
      console.error("Ce post n'a pas de cible YouTube.");
      process.exit(2);
    }
    if (target.status === "FAILED") {
      console.error(`Publication YouTube en échec : ${target.error ?? "raison inconnue"}`);
      process.exit(2);
    }
    const id = typeof target.url === "string" ? target.url.split("/shorts/")[1]?.split(/[?#/]/)[0] : undefined;
    const ready = id && ["PLATFORM_SCHEDULED", "PUBLISHED"].includes(target.status) && target.youtube_live?.upload_status === "processed";
    if (ready) {
      console.log(id);
      process.exit(0);
    }
    const state = `${target.status}${target.youtube_live?.upload_status ? ` / ${target.youtube_live.upload_status}` : ""}`;
    if (state !== last) console.error(`En attente de YouTube : ${state}`);
    last = state;
  } catch (err) {
    if (err instanceof NeedLoginError) {
      console.error("Connexion à Social Master requise : node sm-upload.mjs --login");
      process.exit(4);
    }
    console.error(`Lecture du post impossible pour l'instant : ${err instanceof Error ? err.message : String(err)}`);
  }
  if (Date.now() > deadline) {
    console.error("Délai dépassé : la vidéo n'est pas encore traitée par YouTube.");
    process.exit(3);
  }
  await sleep(15_000);
}
