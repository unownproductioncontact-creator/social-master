import { describe, it, expect } from "vitest";
import {
  checkInstagramReelCompatibility,
  checkInstagramImageCompatibility,
  checkTikTokVideoCompatibility,
  checkInstagramCarouselCompatibility,
  checkTikTokPhotoCompatibility,
  isAcceptedUploadType,
} from "@/lib/media-validation";

describe("checkInstagramReelCompatibility", () => {
  it("n'a aucune erreur pour une vidéo MP4 valide", () => {
    const issues = checkInstagramReelCompatibility({ mimeType: "video/mp4", sizeBytes: 10_000_000, durationSec: 30 });
    expect(issues.filter((i) => i.level === "error")).toHaveLength(0);
  });

  it("rejette un format vidéo non supporté", () => {
    const issues = checkInstagramReelCompatibility({ mimeType: "video/x-flv", sizeBytes: 1000, durationSec: 10 });
    expect(issues.some((i) => i.level === "error")).toBe(true);
  });

  it("rejette une vidéo trop lourde (>300 Mo)", () => {
    const issues = checkInstagramReelCompatibility({
      mimeType: "video/mp4",
      sizeBytes: 301 * 1024 * 1024,
      durationSec: 30,
    });
    expect(issues.some((i) => i.level === "error" && i.message.includes("lourde"))).toBe(true);
  });

  it("rejette une vidéo trop courte (<3s) et trop longue (>15min)", () => {
    const tooShort = checkInstagramReelCompatibility({ mimeType: "video/mp4", sizeBytes: 1000, durationSec: 1 });
    expect(tooShort.some((i) => i.message.includes("courte"))).toBe(true);

    const tooLong = checkInstagramReelCompatibility({ mimeType: "video/mp4", sizeBytes: 1000, durationSec: 20 * 60 });
    expect(tooLong.some((i) => i.message.includes("longue"))).toBe(true);
  });
});

describe("checkInstagramImageCompatibility", () => {
  it("signale un format non-JPEG comme un simple avertissement (conversion automatique)", () => {
    const issues = checkInstagramImageCompatibility({ mimeType: "image/png", sizeBytes: 1000 });
    expect(issues.every((i) => i.level !== "error")).toBe(true);
    expect(issues.some((i) => i.level === "warning")).toBe(true);
  });

  it("rejette une image trop lourde (>8 Mo)", () => {
    const issues = checkInstagramImageCompatibility({ mimeType: "image/jpeg", sizeBytes: 9 * 1024 * 1024 });
    expect(issues.some((i) => i.level === "error")).toBe(true);
  });

  it("avertit sur un ratio hors bornes (4:5 à 1.91:1)", () => {
    const issues = checkInstagramImageCompatibility({
      mimeType: "image/jpeg",
      sizeBytes: 1000,
      width: 1000,
      height: 3000, // ratio 0.33, bien en dessous de 0.8
    });
    expect(issues.some((i) => i.level === "warning" && i.message.includes("Ratio"))).toBe(true);
  });
});

describe("checkTikTokVideoCompatibility", () => {
  it("rejette une vidéo dépassant la durée max du compte", () => {
    const issues = checkTikTokVideoCompatibility({ mimeType: "video/mp4", sizeBytes: 1000, durationSec: 200 }, 180);
    expect(issues.some((i) => i.level === "error" && i.message.includes("longue"))).toBe(true);
  });

  it("n'a pas d'erreur sous la limite de durée du compte", () => {
    const issues = checkTikTokVideoCompatibility({ mimeType: "video/mp4", sizeBytes: 1000, durationSec: 60 }, 180);
    expect(issues.filter((i) => i.level === "error")).toHaveLength(0);
  });
});

describe("checkInstagramCarouselCompatibility", () => {
  it("rejette moins de 2 médias ou plus de 10", () => {
    expect(checkInstagramCarouselCompatibility(1).length).toBeGreaterThan(0);
    expect(checkInstagramCarouselCompatibility(11).length).toBeGreaterThan(0);
  });

  it("accepte entre 2 et 10 médias", () => {
    expect(checkInstagramCarouselCompatibility(2)).toHaveLength(0);
    expect(checkInstagramCarouselCompatibility(10)).toHaveLength(0);
  });
});

describe("checkTikTokPhotoCompatibility", () => {
  it("rejette 0 média ou plus de 35", () => {
    expect(checkTikTokPhotoCompatibility(0).length).toBeGreaterThan(0);
    expect(checkTikTokPhotoCompatibility(36).length).toBeGreaterThan(0);
  });

  it("accepte entre 1 et 35 médias", () => {
    expect(checkTikTokPhotoCompatibility(1)).toHaveLength(0);
    expect(checkTikTokPhotoCompatibility(35)).toHaveLength(0);
  });
});

describe("isAcceptedUploadType", () => {
  it("accepte les formats image et vidéo supportés", () => {
    expect(isAcceptedUploadType("image/jpeg")).toBe(true);
    expect(isAcceptedUploadType("video/mp4")).toBe(true);
  });

  it("rejette un type non supporté", () => {
    expect(isAcceptedUploadType("application/pdf")).toBe(false);
  });
});
