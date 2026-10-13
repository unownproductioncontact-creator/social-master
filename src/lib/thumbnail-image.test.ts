import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { prepareYouTubeThumbnail } from "@/lib/thumbnail-image";
import { ThumbnailImageError, YOUTUBE_THUMBNAIL_MAX_BYTES } from "@/lib/youtube-thumbnail";

// Vraie bibliothèque d'images (sharp), aucune I/O réseau : on vérifie ce qui part chez YouTube.

/** Bruit aléatoire : incompressible, donc lourd en PNG comme en JPEG haute qualité. */
function noise(width: number, height: number): Buffer {
  const pixels = Buffer.alloc(width * height * 3);
  for (let i = 0; i < pixels.length; i++) pixels[i] = Math.floor(Math.random() * 256);
  return pixels;
}

async function png(width: number, height: number): Promise<Buffer> {
  return sharp(noise(width, height), { raw: { width, height, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
}

describe("prepareYouTubeThumbnail", () => {
  it("un JPEG léger 1080×1920 part tel quel (même octets)", async () => {
    const jpeg = await sharp({ create: { width: 1080, height: 1920, channels: 3, background: "#ff3355" } }).jpeg().toBuffer();
    const prepared = await prepareYouTubeThumbnail(jpeg, "image/jpeg");
    expect(prepared.recompressed).toBe(false);
    expect(prepared.data).toBe(jpeg);
    expect(prepared.contentType).toBe("image/jpeg");
    expect([prepared.width, prepared.height]).toEqual([1080, 1920]);
  });

  it("un PNG de plus de 2 Mo devient un JPEG de moins de 2 Mo AUX MÊMES DIMENSIONS (9:16 gardé)", async () => {
    const big = await png(1080, 1920);
    expect(big.length).toBeGreaterThan(YOUTUBE_THUMBNAIL_MAX_BYTES);
    const prepared = await prepareYouTubeThumbnail(big, "image/png");
    expect(prepared.recompressed).toBe(true);
    expect(prepared.contentType).toBe("image/jpeg");
    expect(prepared.data.length).toBeLessThanOrEqual(YOUTUBE_THUMBNAIL_MAX_BYTES);
    const meta = await sharp(prepared.data).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["jpeg", 1080, 1920]);
  });

  it("un WebP (format non accepté tel quel) est converti en JPEG même s'il est léger", async () => {
    const webp = await sharp({ create: { width: 720, height: 1280, channels: 3, background: "#123456" } }).webp().toBuffer();
    const prepared = await prepareYouTubeThumbnail(webp, "image/webp");
    expect(prepared.recompressed).toBe(true);
    expect(prepared.contentType).toBe("image/jpeg");
    expect((await sharp(prepared.data).metadata()).format).toBe("jpeg");
  });

  it("dernier recours pour une source géante : réduction dans le cadre 1080×1920, jamais de recadrage", async () => {
    // Bruit 1620×2880 : ~1,0 Mo en JPEG qualité 40 à pleine taille (mesuré). Avec un plafond abaissé à
    // 800 000 octets, aucune qualité ne suffit sans réduire → repli 1080×1920 (~0,5 Mo en qualité 40).
    const giant = await png(1620, 2880);
    const prepared = await prepareYouTubeThumbnail(giant, "image/png", 800_000);
    expect(prepared.data.length).toBeLessThanOrEqual(800_000);
    const meta = await sharp(prepared.data).metadata();
    expect([meta.width, meta.height]).toEqual([1080, 1920]);
  });

  it("fichier qui n'est pas une image : erreur explicite, jamais retentée", async () => {
    await expect(prepareYouTubeThumbnail(Buffer.from("pas une image"), "image/jpeg")).rejects.toBeInstanceOf(ThumbnailImageError);
  });
});
