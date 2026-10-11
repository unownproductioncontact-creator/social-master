import "server-only";

/**
 * Client du Worker Cloudflare des médias (CLAUDE.md §36) : import par lien et contenu réel du bucket.
 * Les envois YouTube (`/push`) et la lecture signée (`/m/`) sont dans providers/youtube.ts et
 * media-url.ts. Tout est optionnel : sans `MEDIA_WORKER_URL` + `MEDIA_PUSH_SECRET`
 * (`mediaWorkerPushConfig()` renvoie null), l'appelant garde son chemin direct depuis Render.
 */

export type MediaWorkerConfig = { url: string; secret: string };

/** Un import peut durer plusieurs minutes (gros fichier, serveur lent) : même plafond que l'import direct. */
const IMPORT_TIMEOUT_MS = 25 * 60 * 1000;
const USAGE_TIMEOUT_MS = 30_000;
/** Garde-fou : 500 pages × 1000 objets. Au-delà, c'est un bug, pas un bucket. */
const MAX_LISTING_PAGES = 500;

/**
 * Le Worker écrit des espaces de maintien de connexion avant le JSON final : on rogne puis on parse.
 */
export function parseWorkerJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("Réponse vide du Worker Cloudflare.");
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new Error(`Réponse illisible du Worker Cloudflare : ${trimmed.slice(0, 200)}`);
  }
}

/**
 * Issue d'un import par le Worker :
 *  - `ok` : le fichier est dans R2 sous la clé demandée, `size` octets ;
 *  - `refused` : le lien ou le fichier est refusé pour de bon (message français pour l'utilisateur) ;
 *  - `fallback` : le Worker ne peut pas traiter ce fichier (longueur inconnue, contenu compressé) ou
 *    est indisponible — l'appelant fait l'import directement depuis Render, comme avant.
 */
export type WorkerImportOutcome =
  | { kind: "ok"; size: number }
  | { kind: "refused"; message: string }
  | { kind: "fallback"; reason: string };

type WorkerImportResult = {
  ok?: boolean;
  size?: number;
  code?: string;
  status?: number;
  message?: string;
};

/** Traduit la réponse JSON du Worker (`importFromUrl`) en issue exploitable. PUR, testé. */
export function interpretImportResult(result: unknown): WorkerImportOutcome {
  if (typeof result !== "object" || result === null) {
    return { kind: "fallback", reason: "réponse du Worker invalide" };
  }
  const r = result as WorkerImportResult;
  if (r.ok === true) {
    if (typeof r.size === "number" && Number.isSafeInteger(r.size) && r.size > 0) return { kind: "ok", size: r.size };
    return { kind: "fallback", reason: "taille absente de la réponse du Worker" };
  }
  switch (r.code) {
    case "http_error":
      return { kind: "refused", message: `Téléchargement refusé (HTTP ${r.status ?? "?"}). Le lien est-il bien public ?` };
    case "too_large":
      return { kind: "refused", message: "Fichier trop volumineux (2 Go maximum)." };
    case "empty":
      return { kind: "refused", message: "Le fichier téléchargé est vide." };
    case "host_refused":
      return { kind: "refused", message: r.message ?? "Lien refusé." };
    case "bad_redirect":
      return { kind: "refused", message: "Redirection invalide." };
    case "too_many_redirects":
      return { kind: "refused", message: "Trop de redirections." };
    default:
      // length_unknown, encoded (cas attendus), fetch_failed, size_mismatch, storage_error, exists…
      return { kind: "fallback", reason: `${r.code ?? "inconnu"}${r.message ? ` — ${r.message}` : ""}` };
  }
}

/**
 * Demande au Worker de télécharger `url` et de l'écrire dans R2 sous `key`. Ne lève jamais : toute
 * panne (réseau, 5xx, réponse illisible) devient une issue `fallback`.
 */
export async function importViaWorker(
  worker: MediaWorkerConfig,
  input: { url: string; key: string; maxBytes: number; contentType: string },
  fetchImpl: typeof fetch = fetch
): Promise<WorkerImportOutcome> {
  try {
    const res = await fetchImpl(`${worker.url}/import`, {
      method: "POST",
      headers: { Authorization: `Bearer ${worker.secret}`, "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(IMPORT_TIMEOUT_MS),
    });
    if (!res.ok) return { kind: "fallback", reason: `Worker Cloudflare : HTTP ${res.status}` };
    return interpretImportResult(parseWorkerJson(await res.text()));
  } catch (err) {
    return { kind: "fallback", reason: err instanceof Error ? err.message : String(err) };
  }
}

export type BucketObject = { key: string; size: number; uploaded: string | null };
export type BucketListing = { objects: number; bytes: number; keys: BucketObject[] };

type UsagePage = { objects?: unknown; bytes?: unknown; cursor?: unknown; keys?: unknown };

/**
 * Contenu RÉEL du bucket R2 (objets, octets, et la liste des clés si `keys`) en parcourant les pages
 * du Worker (`GET /usage`). Lève si le Worker répond mal : l'appelant décide du repli.
 */
export async function listBucket(
  worker: MediaWorkerConfig,
  options: { prefix?: string; keys?: boolean } = {},
  fetchImpl: typeof fetch = fetch
): Promise<BucketListing> {
  const listing: BucketListing = { objects: 0, bytes: 0, keys: [] };
  let cursor: string | null = null;

  for (let page = 0; page < MAX_LISTING_PAGES; page++) {
    const url = new URL(`${worker.url}/usage`);
    if (options.prefix) url.searchParams.set("prefix", options.prefix);
    if (options.keys) url.searchParams.set("keys", "1");
    if (cursor) url.searchParams.set("cursor", cursor);

    const res = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${worker.secret}` },
      signal: AbortSignal.timeout(USAGE_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Worker Cloudflare : /usage a répondu HTTP ${res.status}`);
    const body = (await res.json()) as UsagePage;

    if (typeof body.objects !== "number" || typeof body.bytes !== "number") {
      throw new Error("Worker Cloudflare : réponse /usage invalide");
    }
    listing.objects += body.objects;
    listing.bytes += body.bytes;
    if (options.keys) {
      if (!Array.isArray(body.keys)) throw new Error("Worker Cloudflare : liste des clés absente de /usage");
      for (const item of body.keys as Array<Partial<BucketObject>>) {
        if (typeof item.key === "string" && typeof item.size === "number") {
          listing.keys.push({ key: item.key, size: item.size, uploaded: typeof item.uploaded === "string" ? item.uploaded : null });
        }
      }
    }
    if (typeof body.cursor !== "string" || !body.cursor) return listing;
    cursor = body.cursor;
  }
  throw new Error(`Worker Cloudflare : listing interrompu après ${MAX_LISTING_PAGES} pages`);
}
