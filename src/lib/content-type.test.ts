import { describe, it, expect } from "vitest";
import {
  computeInstagramContentType,
  computeTikTokContentType,
  computeYouTubeContentType,
  youtubeTitleFallback,
  resolveYouTubeTitle,
  YOUTUBE_TITLE_MAX_LENGTH,
} from "@/lib/content-type";

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

describe("computeYouTubeContentType", () => {
  it("retourne YOUTUBE_SHORT pour exactement 1 vidéo seule", () => {
    expect(computeYouTubeContentType([{ isVideo: true }])).toBe("YOUTUBE_SHORT");
  });

  it("retourne null pour une image seule (pas de photo YouTube en V1)", () => {
    expect(computeYouTubeContentType([{ isVideo: false }])).toBeNull();
  });

  it("retourne null pour plusieurs vidéos (pas de carrousel YouTube en V1)", () => {
    expect(computeYouTubeContentType([{ isVideo: true }, { isVideo: true }])).toBeNull();
  });

  it("retourne null pour un mélange vidéo + image", () => {
    expect(computeYouTubeContentType([{ isVideo: true }, { isVideo: false }])).toBeNull();
  });

  it("retourne null pour une sélection vide", () => {
    expect(computeYouTubeContentType([])).toBeNull();
  });
});

describe("youtubeTitleFallback", () => {
  it("prend la première ligne de la légende", () => {
    expect(youtubeTitleFallback("Ma super vidéo\nDescription détaillée\n#tag")).toBe("Ma super vidéo");
  });

  it("gère les retours ligne Windows (\\r\\n)", () => {
    expect(youtubeTitleFallback("Titre\r\nSuite")).toBe("Titre");
  });

  it("retire les espaces de tête/fin de la première ligne", () => {
    expect(youtubeTitleFallback("  Titre espacé  \nreste")).toBe("Titre espacé");
  });

  it("tronque à 100 caractères", () => {
    const long = "a".repeat(150);
    expect(youtubeTitleFallback(long)).toHaveLength(YOUTUBE_TITLE_MAX_LENGTH);
    expect(youtubeTitleFallback(long)).toBe("a".repeat(100));
  });

  it("renvoie une chaîne vide pour une légende vide", () => {
    expect(youtubeTitleFallback("")).toBe("");
    expect(youtubeTitleFallback("   \n  ")).toBe("");
  });
});

describe("resolveYouTubeTitle", () => {
  it("privilégie le titre explicite non vide (trimé)", () => {
    expect(resolveYouTubeTitle("  Mon titre  ", "Légende ignorée")).toBe("Mon titre");
  });

  it("retombe sur la 1re ligne de légende si le titre explicite est absent/vide", () => {
    expect(resolveYouTubeTitle(null, "Depuis la légende\nsuite")).toBe("Depuis la légende");
    expect(resolveYouTubeTitle(undefined, "Depuis la légende")).toBe("Depuis la légende");
    expect(resolveYouTubeTitle("   ", "Depuis la légende")).toBe("Depuis la légende");
  });

  it("tronque aussi un titre explicite trop long à 100 caractères", () => {
    expect(resolveYouTubeTitle("b".repeat(120), "légende")).toHaveLength(YOUTUBE_TITLE_MAX_LENGTH);
  });
});
