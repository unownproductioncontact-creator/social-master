import { describe, expect, it } from "vitest";
import { convertedJpegKey, objectKeysOfAsset, referencedObjectKeys, thumbnailKeyFor } from "./media-keys";

describe("clés R2 d'un média", () => {
  const key = "media/u1/abc-photo.png";

  it("conventions de nommage : copie JPEG et miniature dérivées de la clé de l'original", () => {
    expect(convertedJpegKey(key)).toBe("media/u1/abc-photo.png.converted.jpg");
    expect(thumbnailKeyFor(key)).toBe("media/u1/abc-photo.png.thumb.jpg");
  });

  it("objectKeysOfAsset : original, miniature et copie JPEG — même si la base ignore la miniature", () => {
    expect(objectKeysOfAsset({ storageKey: key, thumbnailKey: null })).toEqual([
      key,
      "media/u1/abc-photo.png.thumb.jpg",
      "media/u1/abc-photo.png.converted.jpg",
    ]);
  });

  it("pas de doublon quand la miniature de la base est la clé déterministe", () => {
    const keys = objectKeysOfAsset({ storageKey: key, thumbnailKey: thumbnailKeyFor(key) });
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(3);
  });

  it("une miniature de la base à clé non standard est conservée en plus", () => {
    const keys = objectKeysOfAsset({ storageKey: key, thumbnailKey: "media/u1/ancienne-miniature.jpg" });
    expect(keys).toContain("media/u1/ancienne-miniature.jpg");
    expect(keys).toHaveLength(4);
  });

  it("referencedObjectKeys : union des clés de tous les médias", () => {
    const refs = referencedObjectKeys([
      { storageKey: "media/u1/a.mp4", thumbnailKey: "media/u1/a.mp4.thumb.jpg" },
      { storageKey: "media/u2/b.jpg" },
    ]);
    expect(refs.has("media/u1/a.mp4")).toBe(true);
    expect(refs.has("media/u1/a.mp4.thumb.jpg")).toBe(true);
    expect(refs.has("media/u2/b.jpg.converted.jpg")).toBe(true);
    expect(refs.has("media/u3/c.jpg")).toBe(false);
  });
});
