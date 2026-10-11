import { describe, expect, it, vi } from "vitest";
import { importViaWorker, interpretImportResult, listBucket, parseWorkerJson } from "./media-worker";

const worker = { url: "https://w.example.dev", secret: "s3cret" };

function jsonResponse(body: unknown, init: ResponseInit = {}, pad = "") {
  return new Response(pad + JSON.stringify(body), { status: 200, ...init });
}

describe("parseWorkerJson", () => {
  it("accepte le JSON précédé des espaces de maintien de connexion", () => {
    expect(parseWorkerJson('   \n {"ok":true}')).toEqual({ ok: true });
  });

  it("réponse vide ou illisible → erreur claire", () => {
    expect(() => parseWorkerJson("   ")).toThrow(/vide/);
    expect(() => parseWorkerJson("<html>502</html>")).toThrow(/illisible/);
  });
});

describe("interpretImportResult", () => {
  it("succès", () => {
    expect(interpretImportResult({ ok: true, size: 1234 })).toEqual({ kind: "ok", size: 1234 });
  });

  it("refus définitifs : message français pour l'utilisateur", () => {
    expect(interpretImportResult({ ok: false, code: "http_error", status: 404 })).toEqual({
      kind: "refused",
      message: "Téléchargement refusé (HTTP 404). Le lien est-il bien public ?",
    });
    expect(interpretImportResult({ ok: false, code: "too_large", size: 3e9 })).toMatchObject({ kind: "refused", message: expect.stringContaining("2 Go") });
    expect(interpretImportResult({ ok: false, code: "host_refused", message: "Lien refusé : adresse non publique." })).toEqual({
      kind: "refused",
      message: "Lien refusé : adresse non publique.",
    });
  });

  it("longueur inconnue, contenu compressé et pannes du Worker → repli sur l'import direct", () => {
    for (const code of ["length_unknown", "encoded", "fetch_failed", "size_mismatch", "storage_error", "exists", "inattendu"]) {
      expect(interpretImportResult({ ok: false, code }).kind).toBe("fallback");
    }
  });

  it("réponse invalide ou succès sans taille → repli, jamais un faux succès", () => {
    expect(interpretImportResult(null).kind).toBe("fallback");
    expect(interpretImportResult("ok").kind).toBe("fallback");
    expect(interpretImportResult({ ok: true }).kind).toBe("fallback");
    expect(interpretImportResult({ ok: true, size: 0 }).kind).toBe("fallback");
  });
});

describe("importViaWorker", () => {
  const input = { url: "https://drive.usercontent.google.com/download?id=x", key: "media/u/k.mp4", maxBytes: 2e9, contentType: "video/mp4" };

  it("appelle POST /import avec le secret et le corps attendu, lit la réponse avec espaces", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, size: 500 }, {}, "   "));
    const outcome = await importViaWorker(worker, input, fetchMock as unknown as typeof fetch);

    expect(outcome).toEqual({ kind: "ok", size: 500 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://w.example.dev/import");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer s3cret");
    expect(JSON.parse(init.body as string)).toEqual(input);
  });

  it("ne lève jamais : 401, 5xx, réseau et réponse illisible deviennent un repli", async () => {
    const cases: Array<() => Promise<Response>> = [
      async () => new Response("Unauthorized", { status: 401 }),
      async () => new Response("boom", { status: 502 }),
      async () => {
        throw new TypeError("fetch failed");
      },
      async () => new Response("pas du json", { status: 200 }),
    ];
    for (const makeResponse of cases) {
      const outcome = await importViaWorker(worker, input, vi.fn(makeResponse) as unknown as typeof fetch);
      expect(outcome.kind).toBe("fallback");
    }
  });
});

describe("listBucket", () => {
  it("additionne les pages en suivant le curseur, avec préfixe et liste des clés", async () => {
    const pages = [
      { objects: 2, bytes: 300, cursor: "c1", keys: [{ key: "media/a", size: 100, uploaded: "2026-10-01T00:00:00.000Z" }, { key: "media/b", size: 200, uploaded: null }] },
      { objects: 1, bytes: 50, cursor: null, keys: [{ key: "media/c", size: 50, uploaded: "2026-10-02T00:00:00.000Z" }] },
    ];
    const fetchMock = vi.fn(async () => Response.json(pages.shift()));
    const listing = await listBucket(worker, { prefix: "media/", keys: true }, fetchMock as unknown as typeof fetch);

    expect(listing).toMatchObject({ objects: 3, bytes: 350 });
    expect(listing.keys.map((k) => k.key)).toEqual(["media/a", "media/b", "media/c"]);
    const first = new URL(String((fetchMock.mock.calls[0] as unknown[])[0]));
    expect(first.pathname).toBe("/usage");
    expect(first.searchParams.get("prefix")).toBe("media/");
    expect(first.searchParams.get("keys")).toBe("1");
    expect(new URL(String((fetchMock.mock.calls[1] as unknown[])[0])).searchParams.get("cursor")).toBe("c1");
  });

  it("lève si le Worker répond une erreur ou un corps invalide (l'appelant décide du repli)", async () => {
    await expect(listBucket(worker, {}, (async () => new Response("no", { status: 401 })) as unknown as typeof fetch)).rejects.toThrow(/401/);
    await expect(listBucket(worker, {}, (async () => Response.json({ nope: true })) as unknown as typeof fetch)).rejects.toThrow(/invalide/);
  });
});
