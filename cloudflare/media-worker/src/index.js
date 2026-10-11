// Social Master — Worker Cloudflare des médias (CLAUDE.md §36).
//
// Sert les médias de R2 et pousse les envois lourds à la place de Render : la sortie de données de
// Cloudflare est gratuite, celle de Render est facturée au-delà de 5 Go par mois (suspension du
// 11/10/2026). Render ne fait plus passer aucun gros fichier.
//
//   GET|HEAD /m/<clé>?exp=<epoch s>&sig=<hex>  lecture signée : HMAC-SHA256("<clé>\n<exp>", SIGNING_SECRET)
//   GET /tiktok<jeton>.txt                      fichiers de vérification d'URL TikTok (variable TIKTOK_VERIFICATIONS)
//   POST /push                                  (Bearer PUSH_SECRET) envoie un objet R2 vers un hôte autorisé
//   POST /import                                (Bearer PUSH_SECRET) télécharge une URL publique et l'écrit dans R2
//   GET /usage?cursor=&prefix=&keys=1           (Bearer PUSH_SECRET) une page du contenu réel du bucket
//   POST /selftest/push                         (Bearer PUSH_SECRET, SELFTEST=1) mesure d'un envoi de test

import { importFromUrl, isValidImportKey, checkImportUrl } from "./import.js";

// Hôtes vers lesquels /push peut envoyer : jamais un relais ouvert.
const PUSH_HOSTS = new Set(["www.googleapis.com", "youtube.googleapis.com"]);
const SELFTEST_URL = "https://speed.cloudflare.com/__up";
const encoder = new TextEncoder();

// Plafond d'un import (même valeur que l'application : MAX_IMPORT_BYTES).
const MAX_IMPORT_BYTES = 2_000_000_000;
// Pendant un import, un espace est écrit toutes les 10 s : la connexion de l'appelant ne reste jamais
// muette (sinon son client HTTP abandonne au bout de 5 min sans en-têtes). Un JSON précédé d'espaces
// reste du JSON valide.
const KEEPALIVE_MS = 10_000;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith("/m/") && (request.method === "GET" || request.method === "HEAD")) {
        return await serveMedia(request, env, url);
      }
      if (request.method === "GET" && /^\/tiktok[A-Za-z0-9]+\.txt$/.test(url.pathname)) {
        return serveTikTokVerification(env, url.pathname.slice(1));
      }
      if (request.method === "POST" && url.pathname === "/push") return await push(request, env);
      if (request.method === "POST" && url.pathname === "/import") return await importRoute(request, env, ctx, url);
      if (request.method === "GET" && url.pathname === "/usage") return await usage(request, env, url);
      if (request.method === "POST" && url.pathname === "/selftest/push" && env.SELFTEST === "1") {
        return await selftestPush(request, env);
      }
      return new Response("Not found", { status: 404 });
    } catch (err) {
      console.error("[media-worker]", err && err.stack ? err.stack : err);
      return Response.json({ error: "internal_error" }, { status: 500 });
    }
  },
};

// ---------------------------------------------------------------- lecture signée

async function hmacKey(secret, usage) {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

function hexToBytes(hex) {
  if (!/^[0-9a-f]{64}$/.test(hex)) return null;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Vérifie la signature (comparaison à temps constant via subtle.verify) et l'expiration. */
async function signatureValid(env, key, exp, sig) {
  if (!env.SIGNING_SECRET || !/^\d{1,12}$/.test(exp || "")) return false;
  if (Number(exp) * 1000 < Date.now()) return false;
  const bytes = hexToBytes(sig || "");
  if (!bytes) return false;
  return crypto.subtle.verify("HMAC", await hmacKey(env.SIGNING_SECRET, "verify"), bytes, encoder.encode(`${key}\n${exp}`));
}

async function serveMedia(request, env, url) {
  const key = decodeURIComponent(url.pathname.slice(3));
  if (!key || !(await signatureValid(env, key, url.searchParams.get("exp"), url.searchParams.get("sig")))) {
    return new Response("Forbidden", { status: 403 });
  }

  if (request.method === "HEAD") {
    const head = await env.MEDIA.head(key);
    if (!head) return new Response(null, { status: 404 });
    const headers = baseHeaders(head);
    headers.set("Content-Length", String(head.size));
    return new Response(null, { status: 200, headers });
  }

  // Les requêtes Range (lecture vidéo dans le navigateur, téléchargements partiels de Meta ou TikTok)
  // sont transmises telles quelles à R2.
  const hasRange = request.headers.has("range");
  const object = await env.MEDIA.get(key, hasRange ? { range: request.headers } : undefined);
  if (!object) return new Response("Not found", { status: 404 });

  const headers = baseHeaders(object);
  if (hasRange && object.range) {
    const offset = object.range.offset ?? (object.range.suffix != null ? object.size - object.range.suffix : 0);
    const length = object.range.length ?? object.range.suffix ?? object.size - offset;
    headers.set("Content-Range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
    headers.set("Content-Length", String(length));
    return new Response(object.body, { status: 206, headers });
  }
  headers.set("Content-Length", String(object.size));
  return new Response(object.body, { status: 200, headers });
}

function baseHeaders(object) {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("ETag", object.httpEtag);
  headers.set("Accept-Ranges", "bytes");
  // Fichiers envoyés par les utilisateurs : affichés tels quels, jamais interprétés (comme /api/m/).
  headers.set("Content-Disposition", "inline");
  headers.set("X-Content-Type-Options", "nosniff");
  // Lien signé et temporaire : rien à mettre en cache côté partagé.
  headers.set("Cache-Control", "private, max-age=3600");
  return headers;
}

function serveTikTokVerification(env, fileName) {
  let files = {};
  try {
    files = JSON.parse(env.TIKTOK_VERIFICATIONS || "{}");
  } catch {
    files = {};
  }
  const content = files[fileName];
  if (!content) return new Response("Not found", { status: 404 });
  return new Response(content, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

// ---------------------------------------------------------------- envois poussés depuis R2

function authorized(request, env) {
  const header = request.headers.get("authorization") || "";
  return Boolean(env.PUSH_SECRET) && timingSafeEqual(header, `Bearer ${env.PUSH_SECRET}`);
}

function timingSafeEqual(a, b) {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** Lit l'objet (ou la plage demandée) dans R2 ; null s'il n'existe pas. */
async function readObject(env, key, range) {
  if (range) {
    const offset = Number(range.offset);
    const length = Number(range.length);
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length <= 0) {
      throw new Error("plage invalide");
    }
    const object = await env.MEDIA.get(key, { range: { offset, length } });
    return object && { object, length };
  }
  const object = await env.MEDIA.get(key);
  return object && { object, length: object.size };
}

/**
 * Corps JSON : { key, url, method = "PUT", headers = {}, range? = { offset, length } }.
 * Renvoie le statut, quelques en-têtes et le corps (tronqué) de la réponse de la cible.
 */
async function push(request, env) {
  if (!authorized(request, env)) return new Response("Unauthorized", { status: 401 });
  const { key, url, method = "PUT", headers = {}, range } = await request.json();
  let target;
  try {
    target = new URL(url);
  } catch {
    return Response.json({ error: "url_invalide" }, { status: 400 });
  }
  if (target.protocol !== "https:" || !PUSH_HOSTS.has(target.hostname)) {
    return Response.json({ error: "hote_non_autorise", host: target.hostname }, { status: 400 });
  }
  if (method !== "PUT" && method !== "POST") return Response.json({ error: "methode_non_autorisee" }, { status: 400 });

  const read = await readObject(env, String(key || ""), range);
  if (!read) return Response.json({ error: "objet_introuvable" }, { status: 404 });

  const outHeaders = new Headers(headers);
  outHeaders.set("Content-Length", String(read.length));
  const started = Date.now();
  const res = await fetch(target, { method, headers: outHeaders, body: read.object.body });
  const body = await res.text();
  const picked = {};
  for (const name of ["location", "range", "content-type"]) {
    const value = res.headers.get(name);
    if (value) picked[name] = value;
  }
  return Response.json({ status: res.status, headers: picked, body: body.slice(0, 20000), bytes: read.length, ms: Date.now() - started });
}

// ---------------------------------------------------------------- import par lien

/**
 * Corps JSON : { url, key, maxBytes? , contentType? }. Écrit le fichier distant dans R2 sous `key`
 * (jamais d'écrasement, clé limitée à media/<utilisateur>/<fichier>). La réponse est un flux JSON :
 * des espaces de maintien de connexion, puis le résultat de `importFromUrl` — toujours HTTP 200 une
 * fois l'import démarré, c'est le champ `ok` qui fait foi.
 */
async function importRoute(request, env, ctx, url) {
  if (!authorized(request, env)) return new Response("Unauthorized", { status: 401 });
  let input;
  try {
    input = await request.json();
  } catch {
    return Response.json({ error: "corps_invalide" }, { status: 400 });
  }
  const key = String((input && input.key) || "");
  if (!isValidImportKey(key)) return Response.json({ error: "cle_invalide" }, { status: 400 });
  const target = String((input && input.url) || "");
  const checked = checkImportUrl(target, url.hostname);
  if (!checked.ok) return Response.json({ ok: false, code: "host_refused", message: checked.message });

  const requested = Number(input.maxBytes);
  const maxBytes = Number.isSafeInteger(requested) && requested > 0 ? Math.min(requested, MAX_IMPORT_BYTES) : MAX_IMPORT_BYTES;
  const contentType = typeof input.contentType === "string" && input.contentType.length <= 100 ? input.contentType : undefined;

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const keepAlive = setInterval(() => {
    writer.write(encoder.encode(" ")).catch(() => {});
  }, KEEPALIVE_MS);

  const started = Date.now();
  const job = importFromUrl(env, { url: target, key, maxBytes, contentType, selfHost: url.hostname })
    .catch((err) => ({ ok: false, code: "storage_error", message: String((err && err.message) || err).slice(0, 200) }))
    .then(async (result) => {
      clearInterval(keepAlive);
      // Jamais l'URL dans les journaux (elle peut porter un jeton de partage) : hôte seulement.
      console.log(
        "[media-worker] import",
        JSON.stringify({ host: checked.url.hostname, key, ok: result.ok, code: result.code, size: result.size, ms: Date.now() - started })
      );
      try {
        await writer.write(encoder.encode(JSON.stringify(result)));
        await writer.close();
      } catch {
        // l'appelant a raccroché : le résultat est perdu, mais l'objet écrit sera nettoyé par le balayage
      }
    });
  ctx.waitUntil(job);

  return new Response(readable, { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

// ---------------------------------------------------------------- contenu réel du bucket

/**
 * Une page (≤ 1000 objets) du contenu réel du bucket : nombre d'objets et octets cumulés, plus la
 * liste (clé, taille, date) si `keys=1`. L'appelant enchaîne les pages avec `cursor` : chaque appel
 * reste court, donc loin des 10 ms de CPU du plan gratuit quelle que soit la taille du bucket.
 */
async function usage(request, env, url) {
  if (!authorized(request, env)) return new Response("Unauthorized", { status: 401 });
  const options = { limit: 1000 };
  const cursor = url.searchParams.get("cursor");
  const prefix = url.searchParams.get("prefix");
  if (cursor) options.cursor = cursor;
  if (prefix) options.prefix = prefix;

  const page = await env.MEDIA.list(options);
  let bytes = 0;
  for (const object of page.objects) bytes += object.size;
  const body = {
    objects: page.objects.length,
    bytes,
    cursor: page.truncated ? page.cursor : null,
  };
  if (url.searchParams.get("keys") === "1") {
    body.keys = page.objects.map((object) => ({
      key: object.key,
      size: object.size,
      uploaded: object.uploaded instanceof Date ? object.uploaded.toISOString() : null,
    }));
  }
  return Response.json(body, { headers: { "Cache-Control": "no-store" } });
}

/** Mesure : pousse un objet R2 entier vers le point de test de débit de Cloudflare. */
async function selftestPush(request, env) {
  if (!authorized(request, env)) return new Response("Unauthorized", { status: 401 });
  const { key } = await request.json();
  const read = await readObject(env, String(key || ""));
  if (!read) return Response.json({ error: "objet_introuvable" }, { status: 404 });
  const started = Date.now();
  const res = await fetch(SELFTEST_URL, {
    method: "POST",
    headers: { "Content-Length": String(read.length), "Content-Type": "application/octet-stream" },
    body: read.object.body,
  });
  await res.arrayBuffer();
  return Response.json({ status: res.status, bytes: read.length, ms: Date.now() - started });
}
