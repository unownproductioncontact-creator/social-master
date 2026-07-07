import { describe, it, expect } from "vitest";
import { computeInstagramContentType, computeTikTokContentType } from "@/lib/content-type";

describe("computeInstagramContentType", () => {
  it("retourne REEL pour 1 vidéo sans story", () => {
    expect(computeInstagramContentType(1, true, false)).toBe("REEL");
  });

  it("retourne IMAGE pour 1 image sans story", () => {
    expect(computeInstagramContentType(1, false, false)).toBe("IMAGE");
  });

  it("retourne STORY quand demandé et 1 seul média, même vidéo", () => {
    expect(computeInstagramContentType(1, true, true)).toBe("STORY");
    expect(computeInstagramContentType(1, false, true)).toBe("STORY");
  });

  it("retourne CAROUSEL dès que plus d'un média, même si story est cochée", () => {
    expect(computeInstagramContentType(2, false, true)).toBe("CAROUSEL");
    expect(computeInstagramContentType(5, true, false)).toBe("CAROUSEL");
  });
});

describe("computeTikTokContentType", () => {
  it("retourne TIKTOK_VIDEO pour exactement 1 vidéo seule", () => {
    expect(computeTikTokContentType([{ isVideo: true }])).toBe("TIKTOK_VIDEO");
  });

  it("retourne TIKTOK_PHOTO pour 1 ou plusieurs images sans vidéo", () => {
    expect(computeTikTokContentType([{ isVideo: false }])).toBe("TIKTOK_PHOTO");
    expect(computeTikTokContentType([{ isVideo: false }, { isVideo: false }, { isVideo: false }])).toBe(
      "TIKTOK_PHOTO"
    );
  });

  it("retourne null pour un mélange photo + vidéo", () => {
    expect(computeTikTokContentType([{ isVideo: true }, { isVideo: false }])).toBeNull();
  });

  it("retourne null pour plusieurs vidéos", () => {
    expect(computeTikTokContentType([{ isVideo: true }, { isVideo: true }])).toBeNull();
  });

  it("retourne null pour une sélection vide", () => {
    expect(computeTikTokContentType([])).toBeNull();
  });
});
