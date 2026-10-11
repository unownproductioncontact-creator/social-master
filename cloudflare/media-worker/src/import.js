// Import par lien dans le Worker (CLAUDE.md §36, point 4) : le Worker télécharge une URL publique et
// l'écrit directement dans R2. Rien ne transite par Render (sa sortie est facturée au-delà de 5 Go/mois,
// son entrée est gratuite : il ne lit plus que les premiers octets pour reconnaître le fichier).
//
// Zéro copie côté JavaScript : le corps de la réponse distante est branché tel quel sur `R2.put`, donc
// rien n'est décompté dans les 10 ms de CPU du plan gratuit (même mécanisme que `/push`). C'est pour
// ça qu'un fichier de taille inconnue (réponse « chunked ») est refusé ici : R2 exige une longueur
// connue pour un flux, et la lire en mémoire par morceaux coûterait du CPU. L'appelant garde alors
// son import direct (Render → R2) pour ce cas rare.

export const MAX_REDIRECTS = 5;

// Noms réservés / internes : jamais joignables depuis Internet, refusés d'emblée.
const BLOCKED_SUFFIXES = [".local", ".localhost", ".internal", ".lan", ".home", ".intranet", ".corp", ".test", ".invalid", ".example", ".onion"];

// Clé d'écriture autorisée : exactement ce que `buildStorageKey` de l'application produit
// (media/<id utilisateur>/<uuid>-<nom nettoyé>). Le Worker n'écrit jamais ailleurs.
const KEY_PATTERN = /^media\/[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9._-]{1,200}$/;

export function isValidImportKey(key) {
  return typeof key === "string" && KEY_PATTERN.test(key) && !key.includes("..");
}

/**
 * Valide une URL à télécharger : https, nom de domaine public (jamais une adresse IP ni un nom
 * interne), port par défaut, sans identifiants, et jamais le Worker lui-même. Le Worker n'a de toute
 * façon aucun accès à un réseau privé, c'est une défense en profondeur ; l'application vérifie en plus
 * la résolution DNS du premier lien avant de nous le confier.
 */
export function checkImportUrl(raw, selfHost) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, message: "Lien invalide." };
  }
  if (url.protocol !== "https:") return { ok: false, message: "Seuls les liens https sont acceptés." };
  if (url.username || url.password) return { ok: false, message: "Lien avec identifiants refusé." };
  if (url.port && url.port !== "443") return { ok: false, message: "Port non standard refusé." };

  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host === String(selfHost || "").toLowerCase()) return { ok: false, message: "Lien refusé." };
  // IPv6 littérale ([::1]) et IPv4 sous toutes ses formes (le parseur URL normalise 2130706433 → 127.0.0.1).
  if (host.includes(":") || host.startsWith("[") || /^[0-9.]+$/.test(host)) {
    return { ok: false, message: "Lien refusé : il pointe vers une adresse non publique." };
  }
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return { ok: false, message: "Lien refusé." };
  const tld = host.slice(host.lastIndexOf(".") + 1);
  if (/^\d+$/.test(tld) || host === "localhost" || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) {
    return { ok: false, message: "Lien refusé : il pointe vers une adresse non publique." };
  }
  return { ok: true, url };
}

/**
 * Télécharge `url` (redirections suivies à la main, chacune re-validée) et l'écrit dans R2 sous `key`
 * sans jamais écraser un objet existant. Renvoie toujours un objet { ok, … } (jamais d'exception pour
 * un cas métier) :
 *   { ok: true, size, contentType, contentDisposition }
 *   { ok: false, code, status?, size?, message? } avec code ∈ host_refused | bad_redirect |
 *   too_many_redirects | http_error | length_unknown | encoded | too_large | empty | exists |
 *   size_mismatch | fetch_failed | storage_error
 */
export async function importFromUrl(env, { url, key, maxBytes, contentType, selfHost }, fetchImpl = fetch) {
  let current = url;
  let res = null;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const checked = checkImportUrl(current, selfHost);
    if (!checked.ok) return { ok: false, code: "host_refused", message: checked.message };
    try {
      res = await fetchImpl(checked.url.toString(), {
        redirect: "manual",
        headers: { "User-Agent": "SocialMaster-Import/1.0" },
      });
    } catch (err) {
      return { ok: false, code: "fetch_failed", message: String((err && err.message) || err).slice(0, 200) };
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) return { ok: false, code: "bad_redirect" };
      try {
        await res.body?.cancel();
      } catch {
        // flux déjà fermé : sans importance
      }
      try {
        current = new URL(location, checked.url).toString();
      } catch {
        return { ok: false, code: "bad_redirect" };
      }
      res = null;
      continue;
    }
    break;
  }
  if (!res) return { ok: false, code: "too_many_redirects" };

  if (!res.ok) {
    try {
      await res.body?.cancel();
    } catch {
      // sans importance
    }
    return { ok: false, code: "http_error", status: res.status };
  }
  if (!res.body) return { ok: false, code: "empty" };

  const cancel = async () => {
    try {
      await res.body.cancel();
    } catch {
      // sans importance
    }
  };
  // Un contenu compressé par le transport n'a plus la longueur annoncée une fois décodé.
  const encoding = (res.headers.get("content-encoding") || "").toLowerCase();
  if (encoding && encoding !== "identity") {
    await cancel();
    return { ok: false, code: "encoded" };
  }
  const declared = res.headers.get("content-length");
  const size = declared === null ? NaN : Number(declared);
  if (!Number.isSafeInteger(size)) {
    await cancel();
    return { ok: false, code: "length_unknown" };
  }
  if (size <= 0) {
    await cancel();
    return { ok: false, code: "empty" };
  }
  if (size > maxBytes) {
    await cancel();
    return { ok: false, code: "too_large", size };
  }

  const remoteType = res.headers.get("content-type");
  const storedType = contentType || remoteType || "application/octet-stream";
  let stored;
  try {
    stored = await env.MEDIA.put(key, res.body, {
      httpMetadata: { contentType: storedType },
      // Jamais d'écrasement : si la clé existe déjà, R2 renvoie null et rien n'est écrit.
      onlyIf: { etagDoesNotMatch: "*" },
    });
  } catch (err) {
    return { ok: false, code: "storage_error", message: String((err && err.message) || err).slice(0, 200) };
  }
  if (stored === null || stored === undefined) return { ok: false, code: "exists" };
  if (stored.size !== size) {
    await env.MEDIA.delete(key).catch(() => {});
    return { ok: false, code: "size_mismatch", size: stored.size };
  }
  return {
    ok: true,
    size,
    contentType: storedType,
    contentDisposition: res.headers.get("content-disposition"),
  };
}
