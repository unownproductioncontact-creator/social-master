import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { resolveShareLink } from "@/lib/media-import/share-link";
import { isPublicIp } from "@/lib/media-import/network-guard";
import { fileNameFromContentDisposition, finalFileName, looksLikeHtml, sniffMediaType } from "@/lib/media-import/sniff";
import { parseVideoMeta, type ByteReader } from "@/lib/media-import/mp4-meta";

const FIXTURES = path.resolve(__dirname, "../../test/fixtures");

async function fileReader(name: string): Promise<ByteReader & { reads: number }> {
  const buf = new Uint8Array(await readFile(path.join(FIXTURES, name)));
  const reader = {
    size: buf.length,
    reads: 0,
    async read(offset: number, length: number) {
      reader.reads++;
      return buf.slice(offset, offset + length);
    },
  };
  return reader;
}

describe("resolveShareLink", () => {
  it("Google Drive (« Copier le lien ») → téléchargement direct sans page d'avertissement", () => {
    const r = resolveShareLink("https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp_qRsTuV/view?usp=sharing");
    expect(r).toEqual({
      ok: true,
      provider: "google-drive",
      downloadUrl: "https://drive.usercontent.google.com/download?id=1AbCdEfGhIjKlMnOp_qRsTuV&export=download&confirm=t",
    });
    expect(resolveShareLink("https://drive.google.com/open?id=1AbCdEfGhIjKlMnOp_qRsTuV").ok).toBe(true);
  });

  it("dossier Drive ou Dropbox → erreur explicite", () => {
    const drive = resolveShareLink("https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOp");
    const dropbox = resolveShareLink("https://www.dropbox.com/scl/fo/abc123/xyz?rlkey=k");
    expect(drive.ok).toBe(false);
    expect(dropbox.ok).toBe(false);
  });

  it("Dropbox fichier → dl=1 (téléchargement direct)", () => {
    const r = resolveShareLink("https://www.dropbox.com/scl/fi/abc123/video.mp4?rlkey=k&dl=0");
    expect(r.ok && r.provider).toBe("dropbox");
    expect(r.ok && new URL(r.downloadUrl).searchParams.get("dl")).toBe("1");
  });

  it("refuse http, iCloud et les chaînes invalides ; accepte un lien https direct", () => {
    expect(resolveShareLink("http://exemple.fr/v.mp4").ok).toBe(false);
    expect(resolveShareLink("https://www.icloud.com/iclouddrive/0abc#video").ok).toBe(false);
    expect(resolveShareLink("pas un lien").ok).toBe(false);
    expect(resolveShareLink("https://cdn.exemple.fr/v.mp4")).toMatchObject({ ok: true, provider: "direct" });
  });
});

describe("isPublicIp (anti-SSRF)", () => {
  it("bloque privé, boucle locale, link-local/métadonnées, CGNAT, multicast", () => {
    for (const ip of ["10.0.0.1", "127.0.0.1", "169.254.169.254", "172.16.5.4", "192.168.1.1", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1"]) {
      expect(isPublicIp(ip), ip).toBe(false);
    }
  });

  it("laisse passer les adresses publiques", () => {
    for (const ip of ["142.250.74.110", "162.125.66.15", "2606:4700::6810:84e5", "::ffff:8.8.8.8"]) {
      expect(isPublicIp(ip), ip).toBe(true);
    }
  });
});

describe("sniffMediaType / looksLikeHtml / noms de fichiers", () => {
  it("reconnaît MP4, MOV (brand qt), JPEG, PNG, WebP, WebM par leurs octets", async () => {
    const head = async (f: string) => (await (await fileReader(f)).read(0, 16));
    expect(sniffMediaType(await head("landscape-faststart.mp4"))).toBe("video/mp4");
    expect(sniffMediaType(await head("sample.mov"))).toBe("video/quicktime");
    expect(sniffMediaType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffMediaType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image/png");
    expect(sniffMediaType(new TextEncoder().encode("RIFF\u0000\u0000\u0000\u0000WEBPVP8 "))).toBe("image/webp");
    expect(sniffMediaType(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]))).toBe("video/webm");
    expect(sniffMediaType(new TextEncoder().encode("GIF89a......"))).toBeNull();
  });

  it("détecte une page web renvoyée à la place du fichier (lien non public)", () => {
    expect(looksLikeHtml(new TextEncoder().encode("\n  <!DOCTYPE html><html>"))).toBe(true);
    expect(looksLikeHtml(new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]))).toBe(false);
  });

  it("Content-Disposition (filename* prioritaire) et nom final avec l'extension du vrai type", () => {
    expect(fileNameFromContentDisposition(`attachment; filename="clip.mp4"; filename*=UTF-8''Ma%20vid%C3%A9o.mp4`)).toBe("Ma vidéo.mp4");
    expect(fileNameFromContentDisposition("attachment; filename=simple.mov")).toBe("simple.mov");
    expect(fileNameFromContentDisposition(null)).toBeNull();
    const now = new Date("2026-10-01T10:00:00Z");
    expect(finalFileName([undefined, "IMG_1234.MOV"], "video/quicktime", now)).toBe("IMG_1234.mov");
    expect(finalFileName(["  ", null], "video/mp4", now)).toBe("import-2026-10-01.mp4");
  });
});

describe("parseVideoMeta (en-têtes MP4/MOV par lectures partielles)", () => {
  it("MP4 « faststart » paysage : durée et dimensions", async () => {
    expect(await parseVideoMeta(await fileReader("landscape-faststart.mp4"))).toEqual({ durationSec: 2, width: 128, height: 72 });
  });

  it("vidéo de téléphone en portrait (rotation 90°, moov en fin de fichier) : dimensions affichées", async () => {
    const reader = await fileReader("portrait-rotated.mp4");
    expect(await parseVideoMeta(reader)).toEqual({ durationSec: 1, width: 72, height: 128 });
    expect(reader.reads).toBeLessThan(10);
  });

  it("MOV QuickTime", async () => {
    expect(await parseVideoMeta(await fileReader("sample.mov"))).toEqual({ durationSec: 1.5, width: 64, height: 48 });
  });

  it("fichier sans moov → métadonnées nulles, sans planter", async () => {
    const junk = new Uint8Array(64);
    const reader: ByteReader = { size: junk.length, read: async (o, l) => junk.slice(o, o + l) };
    expect(await parseVideoMeta(reader)).toEqual({ durationSec: null, width: null, height: null });
  });
});
