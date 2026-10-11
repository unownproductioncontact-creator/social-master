// Test d'intégration de l'import par lien (CLAUDE.md §30) contre la base de dev locale : vraie
// orchestration (Prisma, détection de type, comptage, métadonnées MP4), avec le RÉSEAU et R2 simulés
// (fetch + DNS + stockage en mémoire) — aucun appel externe.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";

const stored = new Map<string, Uint8Array>();
let dnsAddress = "142.250.74.110";
// Worker Cloudflare : null = non configuré (import direct), sinon l'adresse et le secret simulés.
let workerConfig: { url: string; secret: string } | null = null;

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: dnsAddress, family: 4 }]),
}));

vi.mock("@/lib/storage", () => ({
  buildStorageKey: (userId: string, name: string) => `media/${userId}/test-${name}`,
  uploadStream: vi.fn(async (key: string, body: Readable) => {
    const chunks: Buffer[] = [];
    for await (const c of body) chunks.push(Buffer.from(c));
    stored.set(key, new Uint8Array(Buffer.concat(chunks)));
  }),
  readObjectRange: vi.fn(async (key: string, start: number, end: number) => stored.get(key)!.slice(start, end + 1)),
  getObjectBuffer: vi.fn(async (key: string) => Buffer.from(stored.get(key)!)),
  deleteObject: vi.fn(async (key: string) => void stored.delete(key)),
  mediaWorkerPushConfig: vi.fn(() => workerConfig),
}));

const { db } = await import("@/lib/db");
const { runMediaImport } = await import("@/worker/media-import-job");
const storage = await import("@/lib/storage");

const TEST_EMAIL = "vitest-media-import@test.local";
let userId: string;
let fixture: Uint8Array<ArrayBuffer>;

async function importAsset(url: string): Promise<string> {
  const asset = await db.mediaAsset.create({
    data: { userId, storageKey: "placeholder", mimeType: "application/octet-stream", sizeBytes: 0, status: "UPLOADING", importUrl: url },
  });
  return asset.id;
}

beforeAll(async () => {
  fixture = new Uint8Array(await readFile(path.resolve(__dirname, "../test/fixtures/portrait-rotated.mp4")));
  await db.user.deleteMany({ where: { email: TEST_EMAIL } });
  const user = await db.user.create({ data: { email: TEST_EMAIL, passwordHash: "x", name: "Vitest import" } });
  userId = user.id;
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await db.user.deleteMany({ where: { email: TEST_EMAIL } });
});

beforeEach(() => {
  workerConfig = null;
  dnsAddress = "142.250.74.110";
  vi.mocked(storage.uploadStream).mockClear();
  vi.mocked(storage.deleteObject).mockClear();
});

const DRIVE_LINK = "https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp_qRsTuV/view?usp=sharing";
const WORKER_URL = "https://worker.example.dev";

/**
 * Réseau simulé : le lien de partage renvoie `fixture` (avec Content-Length), le Worker répond à
 * POST /import par `onWorkerImport` — qui peut « écrire dans R2 » (la table `stored`) comme le vrai.
 */
function stubNetwork(options: {
  contentLength?: boolean;
  onWorkerImport?: (body: { url: string; key: string; maxBytes: number; contentType: string }) => Response | Promise<Response>;
}) {
  const workerCalls: Array<{ url: string; key: string; maxBytes: number; contentType: string }> = [];
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(`${WORKER_URL}/import`)) {
      const body = JSON.parse(String(init?.body));
      workerCalls.push(body);
      if (!options.onWorkerImport) throw new Error("Worker non prévu dans ce test");
      return options.onWorkerImport(body);
    }
    return new Response(fixture, {
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": 'attachment; filename="IMG_0420.MOV"',
        ...(options.contentLength === false ? {} : { "content-length": String(fixture.length) }),
      },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, workerCalls };
}

describe("runMediaImport", () => {
  it("lien Google Drive public → média READY avec type, taille et métadonnées vidéo (portrait)", async () => {
    dnsAddress = "142.250.74.110";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(fixture, {
          status: 200,
          headers: { "content-type": "application/octet-stream", "content-disposition": 'attachment; filename="IMG_0420.MOV"' },
        })
      )
    );
    const id = await importAsset("https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp_qRsTuV/view?usp=sharing");

    await runMediaImport(id, false);

    const asset = await db.mediaAsset.findUniqueOrThrow({ where: { id } });
    expect(asset.status).toBe("READY");
    expect(asset.mimeType).toBe("video/mp4"); // type réel détecté, pas l'extension annoncée
    expect(asset.storageKey).toBe(`media/${userId}/test-IMG_0420.mp4`);
    expect(asset.sizeBytes).toBe(fixture.length);
    expect({ width: asset.width, height: asset.height, durationSec: asset.durationSec }).toEqual({ width: 72, height: 128, durationSec: 1 });
    expect(stored.get(asset.storageKey)?.length).toBe(fixture.length);
  });

  it("lien non public (page web renvoyée) → FAILED avec explication, rien de stocké", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<!DOCTYPE html><html>Connexion Google</html>", { status: 200 })));
    const before = stored.size;
    const id = await importAsset("https://drive.google.com/file/d/1ZyXwVuTsRqPoNmLkJiH/view");

    await runMediaImport(id, false);

    const asset = await db.mediaAsset.findUniqueOrThrow({ where: { id } });
    expect(asset.status).toBe("FAILED");
    expect(asset.importError).toMatch(/Tous les utilisateurs disposant du lien/);
    expect(stored.size).toBe(before);
  });

  it("hôte résolu vers une adresse privée → refusé sans aucun téléchargement (anti-SSRF)", async () => {
    dnsAddress = "169.254.169.254";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const id = await importAsset("https://interne.exemple.fr/video.mp4");

    await runMediaImport(id, false);

    expect(fetchMock).not.toHaveBeenCalled();
    const asset = await db.mediaAsset.findUniqueOrThrow({ where: { id } });
    expect(asset.status).toBe("FAILED");
    expect(asset.importError).toMatch(/non publique/);
  });

  it("erreur réseau : relancée par pg-boss, puis échec lisible à la dernière tentative", async () => {
    dnsAddress = "142.250.74.110";
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    const id = await importAsset("https://www.dropbox.com/scl/fi/abc/video.mp4?rlkey=k&dl=0");

    await expect(runMediaImport(id, false)).rejects.toThrow("fetch failed");
    expect((await db.mediaAsset.findUniqueOrThrow({ where: { id } })).status).toBe("UPLOADING");

    await runMediaImport(id, true);
    const asset = await db.mediaAsset.findUniqueOrThrow({ where: { id } });
    expect(asset.status).toBe("FAILED");
    expect(asset.importError).toMatch(/Réessayez/);
  });
});

describe("runMediaImport — Worker Cloudflare (CLAUDE.md §36)", () => {
  it("le Worker télécharge et écrit dans R2 : Render n'envoie rien (uploadStream non appelé), média READY", async () => {
    workerConfig = { url: WORKER_URL, secret: "push-secret" };
    const { workerCalls } = stubNetwork({
      onWorkerImport: (body) => {
        stored.set(body.key, fixture); // le Worker « écrit dans R2 »
        return new Response(`   ${JSON.stringify({ ok: true, size: fixture.length })}`);
      },
    });
    const id = await importAsset(DRIVE_LINK);

    await runMediaImport(id, false);

    const asset = await db.mediaAsset.findUniqueOrThrow({ where: { id } });
    expect(asset.status).toBe("READY");
    expect(asset.mimeType).toBe("video/mp4");
    expect(asset.sizeBytes).toBe(fixture.length);
    expect(asset.storageKey).toBe(`media/${userId}/test-IMG_0420.mp4`);
    expect({ width: asset.width, height: asset.height, durationSec: asset.durationSec }).toEqual({ width: 72, height: 128, durationSec: 1 });
    expect(storage.uploadStream).not.toHaveBeenCalled();
    expect(workerCalls).toHaveLength(1);
    // Le Worker reçoit le lien direct, la clé finale, le plafond et le type RECONNU (pas celui annoncé).
    expect(workerCalls[0]).toMatchObject({
      url: expect.stringContaining("drive.usercontent.google.com/download?id=1AbCdEfGhIjKlMnOp_qRsTuV"),
      key: `media/${userId}/test-IMG_0420.mp4`,
      maxBytes: 2_000_000_000,
      contentType: "video/mp4",
    });
  });

  it("longueur inconnue côté Worker → repli sur l'import direct, la clé tentée est nettoyée", async () => {
    workerConfig = { url: WORKER_URL, secret: "push-secret" };
    const { workerCalls } = stubNetwork({
      onWorkerImport: () => Response.json({ ok: false, code: "length_unknown" }),
    });
    const id = await importAsset(DRIVE_LINK);

    await runMediaImport(id, false);

    const asset = await db.mediaAsset.findUniqueOrThrow({ where: { id } });
    expect(asset.status).toBe("READY");
    expect(workerCalls).toHaveLength(1);
    expect(storage.uploadStream).toHaveBeenCalledTimes(1);
    expect(stored.get(asset.storageKey)?.length).toBe(fixture.length);
    // La clé tentée par le Worker a été nettoyée (best-effort) avant le chemin direct.
    expect(storage.deleteObject).toHaveBeenCalledWith(workerCalls[0].key);
  });

  it("Worker injoignable ou en erreur → import direct, l'utilisateur ne voit rien", async () => {
    workerConfig = { url: WORKER_URL, secret: "push-secret" };
    stubNetwork({
      onWorkerImport: () => {
        throw new TypeError("fetch failed");
      },
    });
    const id = await importAsset(DRIVE_LINK);

    await runMediaImport(id, false);

    expect((await db.mediaAsset.findUniqueOrThrow({ where: { id } })).status).toBe("READY");
    expect(storage.uploadStream).toHaveBeenCalledTimes(1);
  });

  it("refus définitif du Worker (HTTP 404 distant) → FAILED avec le message, pas de repli", async () => {
    workerConfig = { url: WORKER_URL, secret: "push-secret" };
    stubNetwork({
      onWorkerImport: () => Response.json({ ok: false, code: "http_error", status: 404 }),
    });
    const id = await importAsset(DRIVE_LINK);

    await runMediaImport(id, false);

    const asset = await db.mediaAsset.findUniqueOrThrow({ where: { id } });
    expect(asset.status).toBe("FAILED");
    expect(asset.importError).toMatch(/HTTP 404/);
    expect(storage.uploadStream).not.toHaveBeenCalled();
  });

  it("serveur distant sans Content-Length → le Worker n'est même pas appelé (import direct)", async () => {
    workerConfig = { url: WORKER_URL, secret: "push-secret" };
    const { workerCalls } = stubNetwork({ contentLength: false });
    const id = await importAsset(DRIVE_LINK);

    await runMediaImport(id, false);

    expect((await db.mediaAsset.findUniqueOrThrow({ where: { id } })).status).toBe("READY");
    expect(workerCalls).toHaveLength(0);
    expect(storage.uploadStream).toHaveBeenCalledTimes(1);
  });

  it("le Worker a écrit autre chose qu'un média (page HTML) → FAILED et l'objet est supprimé", async () => {
    workerConfig = { url: WORKER_URL, secret: "push-secret" };
    const html = new TextEncoder().encode("<!DOCTYPE html><html>Connexion</html>");
    const { workerCalls } = stubNetwork({
      onWorkerImport: (body) => {
        stored.set(body.key, html);
        return Response.json({ ok: true, size: html.length });
      },
    });
    const id = await importAsset(DRIVE_LINK);

    await runMediaImport(id, false);

    const asset = await db.mediaAsset.findUniqueOrThrow({ where: { id } });
    expect(asset.status).toBe("FAILED");
    expect(stored.has(workerCalls[0].key)).toBe(false);
  });
});
