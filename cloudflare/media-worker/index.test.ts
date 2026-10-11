// Tests du Worker des médias (CLAUDE.md §36) : import par lien, contenu du bucket, garde-fous d'accès.
// Le Worker est du JavaScript pur sans dépendance : il s'exécute tel quel sous Node avec un bucket R2
// et un `fetch` simulés — aucun appel réseau.
import { describe, it, expect, vi, afterEach } from "vitest";
import worker from "./src/index.js";
import { checkImportUrl, importFromUrl, isValidImportKey, MAX_REDIRECTS } from "./src/import.js";

type StoredObject = { bytes: Uint8Array; contentType?: string; uploaded: Date };

async function collect(value: unknown): Promise<Uint8Array> {
  if (value instanceof ReadableStream) return new Uint8Array(await new Response(value).arrayBuffer());
  if (typeof value === "string") return new TextEncoder().encode(value);
  return new Uint8Array(value as ArrayBuffer);
}

/** Bucket R2 en mémoire : put (avec onlyIf), head, delete, list paginé. */
class FakeBucket {
  objects = new Map<string, StoredObject>();
  putCalls = 0;

  async put(
    key: string,
    value: unknown,
    options?: { httpMetadata?: { contentType?: string }; onlyIf?: { etagDoesNotMatch?: string } }
  ) {
    this.putCalls++;
    if (options?.onlyIf?.etagDoesNotMatch === "*" && this.objects.has(key)) return null;
    const bytes = await collect(value);
    this.objects.set(key, { bytes, contentType: options?.httpMetadata?.contentType, uploaded: new Date("2026-10-11T20:00:00Z") });
    return { key, size: bytes.length };
  }
  async head(key: string) {
    const o = this.objects.get(key);
    return o ? { key, size: o.bytes.length } : null;
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
  async list(options: { limit?: number; cursor?: string; prefix?: string }) {
    const all = [...this.objects.entries()]
      .filter(([k]) => !options.prefix || k.startsWith(options.prefix))
      .sort(([a], [b]) => a.localeCompare(b));
    const start = options.cursor ? Number(options.cursor) : 0;
    const limit = options.limit ?? 1000;
    const slice = all.slice(start, start + limit);
    const truncated = start + limit < all.length;
    return {
      objects: slice.map(([key, o]) => ({ key, size: o.bytes.length, uploaded: o.uploaded })),
      truncated,
      cursor: truncated ? String(start + limit) : undefined,
    };
  }
}

const SECRET = "push-secret-test";
const KEY = "media/user_1/0b8f9c2e-1111-4222-8333-444455556666-clip.mp4";

function makeEnv(bucket = new FakeBucket()) {
  return { MEDIA: bucket, PUSH_SECRET: SECRET, SIGNING_SECRET: "sig", SELFTEST: "0", TIKTOK_VERIFICATIONS: "{}" };
}

function makeCtx() {
  const pending: Promise<unknown>[] = [];
  return { ctx: { waitUntil: (p: Promise<unknown>) => void pending.push(p) }, settle: () => Promise.all(pending) };
}

function bodyOf(bytes: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes).fill(7);
}

/** Réponse distante avec Content-Length (comme Google Drive ou Dropbox pour un fichier). */
function remoteFile(bytes: number, headers: Record<string, string> = {}) {
  return new Response(bodyOf(bytes), { status: 200, headers: { "content-length": String(bytes), ...headers } });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("isValidImportKey", () => {
  it("accepte exactement le format de buildStorageKey", () => {
    expect(isValidImportKey(KEY)).toBe(true);
    expect(isValidImportKey("media/cmuvp2vl7003g2pgcp36xf3r4/uuid-Ouverture_d_fi_-_28_euros.mp4")).toBe(true);
  });

  it("refuse tout le reste : autre préfixe, sous-dossier, remontée de chemin, caractères exotiques", () => {
    for (const bad of [
      "",
      "imports/u/x.mp4",
      "media/u/sub/x.mp4",
      "media/../x.mp4",
      "media/u/..",
      "media/u/a b.mp4",
      "media/u/é.mp4",
      "/media/u/x.mp4",
      `media/u/${"a".repeat(201)}`,
    ]) {
      expect(isValidImportKey(bad)).toBe(false);
    }
    expect(isValidImportKey(undefined)).toBe(false);
  });
});

describe("checkImportUrl", () => {
  const self = "social-master-media.unownproduction.workers.dev";

  it("accepte un lien https vers un nom de domaine public", () => {
    expect(checkImportUrl("https://drive.usercontent.google.com/download?id=abc&export=download&confirm=t", self).ok).toBe(true);
    expect(checkImportUrl("https://dl.dropboxusercontent.com/s/abc/video.mp4", self).ok).toBe(true);
    expect(checkImportUrl("https://xn--exemple-9xa.fr/video.mp4", self).ok).toBe(true);
  });

  it("refuse http, les identifiants, les ports non standard et le Worker lui-même", () => {
    expect(checkImportUrl("http://exemple.fr/v.mp4", self).ok).toBe(false);
    expect(checkImportUrl("https://user:pass@exemple.fr/v.mp4", self).ok).toBe(false);
    expect(checkImportUrl("https://exemple.fr:8443/v.mp4", self).ok).toBe(false);
    expect(checkImportUrl(`https://${self}/push`, self).ok).toBe(false);
    expect(checkImportUrl("pas une url", self).ok).toBe(false);
  });

  it("refuse toute adresse IP (IPv4 sous toutes ses formes, IPv6) et les noms internes", () => {
    for (const bad of [
      "https://127.0.0.1/v.mp4",
      "https://169.254.169.254/latest/meta-data",
      "https://10.0.0.5/v.mp4",
      "https://2130706433/v.mp4", // 127.0.0.1 en décimal, normalisé par le parseur
      "https://0x7f.0.0.1/v.mp4",
      "https://[::1]/v.mp4",
      "https://[::ffff:127.0.0.1]/v.mp4",
      "https://localhost/v.mp4",
      "https://nas.local/v.mp4",
      "https://db.internal/v.mp4",
      "https://serveur/v.mp4",
      "https://exemple.123/v.mp4",
    ]) {
      expect(checkImportUrl(bad, self).ok, bad).toBe(false);
    }
  });
});

describe("importFromUrl", () => {
  const base = { url: "https://exemple.fr/video.mp4", key: KEY, maxBytes: 1000, contentType: "video/mp4", selfHost: "w.example.dev" };

  it("fichier de longueur connue : écrit tel quel dans R2 avec le bon type, renvoie taille et nom serveur", async () => {
    const bucket = new FakeBucket();
    const fetchMock = vi.fn(async () =>
      remoteFile(500, { "content-type": "application/octet-stream", "content-disposition": 'attachment; filename="IMG_0420.MOV"' })
    );
    const result = await importFromUrl(makeEnv(bucket), base, fetchMock as unknown as typeof fetch);

    expect(result).toEqual({
      ok: true,
      size: 500,
      contentType: "video/mp4", // le type reconnu par l'application, pas celui annoncé par le serveur
      contentDisposition: 'attachment; filename="IMG_0420.MOV"',
    });
    expect(bucket.objects.get(KEY)?.bytes.length).toBe(500);
    expect(bucket.objects.get(KEY)?.contentType).toBe("video/mp4");
    // Les redirections sont suivies à la main : jamais le suivi automatique de fetch.
    expect(fetchMock).toHaveBeenCalledWith("https://exemple.fr/video.mp4", expect.objectContaining({ redirect: "manual" }));
  });

  it("suit les redirections (Drive → serveur de contenu) en re-validant chaque étape", async () => {
    const bucket = new FakeBucket();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://cdn.exemple.fr/v/abc.mp4?tok=1" } }))
      .mockResolvedValueOnce(remoteFile(300));
    const result = await importFromUrl(makeEnv(bucket), base, fetchMock as unknown as typeof fetch);

    expect(result.ok).toBe(true);
    expect(fetchMock.mock.calls[1][0]).toBe("https://cdn.exemple.fr/v/abc.mp4?tok=1");
  });

  it("une redirection vers une adresse privée est refusée avant tout appel", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://169.254.169.254/latest/meta-data" } }));
    const result = await importFromUrl(makeEnv(), base, fetchMock as unknown as typeof fetch);

    expect(result).toMatchObject({ ok: false, code: "host_refused" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("trop de redirections → too_many_redirects", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://exemple.fr/encore" } }));
    const result = await importFromUrl(makeEnv(), base, fetchMock as unknown as typeof fetch);

    expect(result).toMatchObject({ ok: false, code: "too_many_redirects" });
    expect(fetchMock).toHaveBeenCalledTimes(MAX_REDIRECTS + 1);
  });

  it("longueur inconnue (réponse chunked) ou contenu encodé → refus propre, rien n'est écrit", async () => {
    const bucket = new FakeBucket();
    const chunked = vi.fn(async () => new Response(new ReadableStream({ start: (c) => (c.enqueue(bodyOf(10)), c.close()) }), { status: 200 }));
    expect(await importFromUrl(makeEnv(bucket), base, chunked as unknown as typeof fetch)).toMatchObject({ ok: false, code: "length_unknown" });

    const gzip = vi.fn(async () => remoteFile(100, { "content-encoding": "gzip" }));
    expect(await importFromUrl(makeEnv(bucket), base, gzip as unknown as typeof fetch)).toMatchObject({ ok: false, code: "encoded" });
    expect(bucket.putCalls).toBe(0);
  });

  it("fichier trop gros ou vide → refus avant l'écriture", async () => {
    const bucket = new FakeBucket();
    const big = vi.fn(async () => remoteFile(2000));
    expect(await importFromUrl(makeEnv(bucket), base, big as unknown as typeof fetch)).toMatchObject({ ok: false, code: "too_large", size: 2000 });

    const empty = vi.fn(async () => new Response(null, { status: 200, headers: { "content-length": "0" } }));
    expect(await importFromUrl(makeEnv(bucket), base, empty as unknown as typeof fetch)).toMatchObject({ ok: false, code: "empty" });
    expect(bucket.putCalls).toBe(0);
  });

  it("erreur HTTP distante et panne réseau → codes distincts", async () => {
    const notFound = vi.fn(async () => new Response("nope", { status: 404 }));
    expect(await importFromUrl(makeEnv(), base, notFound as unknown as typeof fetch)).toEqual({ ok: false, code: "http_error", status: 404 });

    const down = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await importFromUrl(makeEnv(), base, down as unknown as typeof fetch)).toMatchObject({ ok: false, code: "fetch_failed", message: "fetch failed" });
  });

  it("n'écrase JAMAIS un objet existant", async () => {
    const bucket = new FakeBucket();
    bucket.objects.set(KEY, { bytes: new Uint8Array([1, 2, 3]), uploaded: new Date() });
    const fetchMock = vi.fn(async () => remoteFile(100));
    const result = await importFromUrl(makeEnv(bucket), base, fetchMock as unknown as typeof fetch);

    expect(result).toMatchObject({ ok: false, code: "exists" });
    expect(bucket.objects.get(KEY)?.bytes).toEqual(new Uint8Array([1, 2, 3]));
  });
});

describe("POST /import (route)", () => {
  function call(body: unknown, headers: Record<string, string> = { authorization: `Bearer ${SECRET}` }, env = makeEnv()) {
    const { ctx, settle } = makeCtx();
    const request = new Request("https://w.example.dev/import", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    return { response: worker.fetch(request, env, ctx), settle, env };
  }

  it("sans le bon secret → 401, et rien n'est téléchargé", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { response } = call({ url: "https://exemple.fr/v.mp4", key: KEY }, { authorization: "Bearer mauvais" });

    expect((await response).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("clé hors de media/<utilisateur>/<fichier> → 400", async () => {
    const { response } = call({ url: "https://exemple.fr/v.mp4", key: "media/../../etc/passwd" });
    expect((await response).status).toBe(400);
  });

  it("URL interdite → réponse JSON ok:false host_refused, sans télécharger", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await call({ url: "https://169.254.169.254/x", key: KEY }).response;

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false, code: "host_refused" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("import réussi : flux JSON (éventuellement précédé d'espaces), objet écrit sous la clé demandée", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => remoteFile(400, { "content-type": "application/octet-stream" })));
    const { response, settle, env } = call({ url: "https://exemple.fr/v.mp4", key: KEY, maxBytes: 1000, contentType: "video/mp4" });
    const res = await response;
    const text = await res.text();
    await settle();

    expect(res.headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(text.trim())).toMatchObject({ ok: true, size: 400, contentType: "video/mp4" });
    expect(env.MEDIA.objects.get(KEY)?.bytes.length).toBe(400);
  });

  it("maxBytes demandé plus bas que le fichier → too_large", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => remoteFile(400)));
    const res = await call({ url: "https://exemple.fr/v.mp4", key: KEY, maxBytes: 100 }).response;

    expect(JSON.parse((await res.text()).trim())).toMatchObject({ ok: false, code: "too_large", size: 400 });
  });
});

describe("GET /usage", () => {
  function seeded(count: number) {
    const bucket = new FakeBucket();
    for (let i = 0; i < count; i++) {
      const key = `media/u1/${String(i).padStart(4, "0")}-f.mp4`;
      bucket.objects.set(key, { bytes: new Uint8Array(10), uploaded: new Date("2026-10-01T00:00:00Z") });
    }
    bucket.objects.set("autre/x.bin", { bytes: new Uint8Array(5), uploaded: new Date("2026-10-01T00:00:00Z") });
    return bucket;
  }
  const get = (path: string, env: ReturnType<typeof makeEnv>, auth = `Bearer ${SECRET}`) =>
    worker.fetch(new Request(`https://w.example.dev${path}`, { headers: { authorization: auth } }), env, makeCtx().ctx);

  it("exige le secret", async () => {
    expect((await get("/usage", makeEnv(seeded(1)), "Bearer faux")).status).toBe(401);
  });

  it("additionne les octets d'une page et rend le curseur suivant", async () => {
    const env = makeEnv(seeded(1500));
    // « autre/x.bin » (5 o) se trie avant « media/… » : 1re page = lui + 999 médias de 10 o.
    const first = await (await get("/usage", env)).json();
    expect(first).toMatchObject({ objects: 1000, bytes: 9995 });
    expect(first.cursor).toBeTruthy();
    expect(first.keys).toBeUndefined();

    const second = await (await get(`/usage?cursor=${first.cursor}`, env)).json();
    expect(second).toMatchObject({ objects: 501, bytes: 5010, cursor: null }); // les 501 médias restants
  });

  it("prefix limite le comptage ; keys=1 ajoute clé, taille et date", async () => {
    const env = makeEnv(seeded(3));
    const body = await (await get("/usage?prefix=media/&keys=1", env)).json();

    expect(body).toMatchObject({ objects: 3, bytes: 30, cursor: null });
    expect(body.keys[0]).toEqual({ key: "media/u1/0000-f.mp4", size: 10, uploaded: "2026-10-01T00:00:00.000Z" });
  });
});
