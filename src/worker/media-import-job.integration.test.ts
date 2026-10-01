// Test d'intégration de l'import par lien (CLAUDE.md §30) contre la base de dev locale : vraie
// orchestration (Prisma, détection de type, comptage, métadonnées MP4), avec le RÉSEAU et R2 simulés
// (fetch + DNS + stockage en mémoire) — aucun appel externe.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";

const stored = new Map<string, Uint8Array>();
let dnsAddress = "142.250.74.110";

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
}));

const { db } = await import("@/lib/db");
const { runMediaImport } = await import("@/worker/media-import-job");

const TEST_EMAIL = "vitest-media-import@test.local";
let userId: string;
let fixture: Uint8Array;

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
