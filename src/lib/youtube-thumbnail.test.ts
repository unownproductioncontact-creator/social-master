import { describe, expect, it } from "vitest";
import {
  canSetThumbnail,
  classifyThumbnailError,
  finalFailureMessage,
  needsThumbnailRecompression,
  pendingRetryMessage,
  processingDecision,
  PROCESSING_MAX_CHECKS,
  readThumbnailUrls,
  summarizeApiError,
  SHORTS_THUMBNAIL_DISABLED_MESSAGE,
  thumbnailApiAllowed,
  ThumbnailImageError,
  YOUTUBE_THUMBNAIL_MAX_BYTES,
} from "@/lib/youtube-thumbnail";
import { thumbnailStillNeeded } from "@/lib/media-retention";

/** Erreur telle que la lève le provider (`setYouTubeThumbnail`). */
function apiError(status: number, reason: string, message = "x"): Error {
  const body = JSON.stringify({ error: { code: status, message, errors: [{ reason, domain: "youtube.thumbnail", message }] } });
  return new Error(`Miniature YouTube refusée (${status}): ${body}`);
}

describe("canSetThumbnail", () => {
  it("youtube.upload (accordé à la connexion) suffit", () => {
    expect(
      canSetThumbnail(["https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtube.readonly"])
    ).toBe(true);
  });
  it("youtube et youtube.force-ssl aussi", () => {
    expect(canSetThumbnail(["https://www.googleapis.com/auth/youtube"])).toBe(true);
    expect(canSetThumbnail(["https://www.googleapis.com/auth/youtube.force-ssl"])).toBe(true);
  });
  it("lecture seule : refusé", () => {
    expect(canSetThumbnail(["https://www.googleapis.com/auth/youtube.readonly"])).toBe(false);
  });
  it("liste vide = inconnue : on laisse YouTube trancher", () => {
    expect(canSetThumbnail([])).toBe(true);
  });
});

describe("needsThumbnailRecompression", () => {
  it("JPEG ou PNG de 2 Mo au plus : tel quel", () => {
    expect(needsThumbnailRecompression("image/jpeg", 1_500_000)).toBe(false);
    expect(needsThumbnailRecompression("image/png", YOUTUBE_THUMBNAIL_MAX_BYTES)).toBe(false);
  });
  it("au-delà de 2 000 000 octets, ou autre format : recompressé", () => {
    expect(needsThumbnailRecompression("image/jpeg", YOUTUBE_THUMBNAIL_MAX_BYTES + 1)).toBe(true);
    expect(needsThumbnailRecompression("image/webp", 100_000)).toBe(true);
  });
});

describe("classifyThumbnailError", () => {
  it("403 : les deux refus documentés sont distingués par leur message", () => {
    const notAllowed = classifyThumbnailError(
      apiError(403, "forbidden", "The authenticated user doesn't have permissions to upload and set custom video thumbnails.")
    );
    expect(notAllowed).toMatchObject({ retryable: false, code: "yt_thumb_not_allowed" });
    expect(notAllowed.message).toMatch(/youtube\.com\/verify/);
    const thisVideo = classifyThumbnailError(
      apiError(403, "forbidden", "The thumbnail can't be set for the specified video. The request might not be properly authorized.")
    );
    expect(thisVideo).toMatchObject({ retryable: false, code: "yt_thumb_forbidden_video" });
    expect(thisVideo.message).toMatch(/CETTE vidéo/);
  });
  it("summarizeApiError : code, raison et message Google, sans le reste", () => {
    expect(summarizeApiError(apiError(403, "forbidden", "The thumbnail can't be set for the specified video.").message)).toBe(
      "403 forbidden — The thumbnail can't be set for the specified video."
    );
    expect(summarizeApiError('Refresh token YouTube échoué (400): {"error":"invalid_grant","error_description":"Token has been expired or revoked."}')).toBe(
      "400 invalid_grant — Token has been expired or revoked."
    );
    expect(summarizeApiError("")).toBeUndefined();
  });
  it("403 forbidden : chaîne non éligible ou non vérifiée, pas de nouvel essai", () => {
    const f = classifyThumbnailError(apiError(403, "forbidden"));
    expect(f).toMatchObject({ retryable: false, code: "yt_thumb_forbidden" });
    expect(f.message).toMatch(/Programme Partenaire/);
    expect(f.message).toMatch(/youtube\.com\/verify/);
  });
  it("400 invalidImage : image invalide, pas de nouvel essai", () => {
    const f = classifyThumbnailError(apiError(400, "invalidImage"));
    expect(f).toMatchObject({ retryable: false, code: "yt_thumb_invalid_image" });
    expect(f.message).toMatch(/2 Mo/);
  });
  it("429 uploadRateLimitExceeded : nouvel essai", () => {
    expect(classifyThumbnailError(apiError(429, "uploadRateLimitExceeded"))).toMatchObject({
      retryable: true,
      code: "yt_thumb_rate_limited",
    });
  });
  it("5xx : nouvel essai", () => {
    expect(classifyThumbnailError(apiError(503, "backendError"))).toMatchObject({ retryable: true, code: "yt_thumb_server_error" });
    expect(classifyThumbnailError(new Error("Miniature YouTube refusée (502): <html>Bad Gateway</html>"))).toMatchObject({
      retryable: true,
      code: "yt_thumb_server_error",
    });
  });
  it("403 quotaExceeded : quota du jour, pas de nouvel essai dans 5 min", () => {
    expect(classifyThumbnailError(apiError(403, "quotaExceeded"))).toMatchObject({ retryable: false, code: "yt_thumb_quota" });
  });
  it("jeton refusé (refresh invalid_grant, 401, insufficientPermissions) : reconnexion", () => {
    const refresh = new Error('Refresh token YouTube échoué (400): {"error":"invalid_grant","error_description":"Token has been expired or revoked."}');
    expect(classifyThumbnailError(refresh)).toMatchObject({ retryable: false, code: "yt_thumb_auth" });
    expect(classifyThumbnailError(apiError(401, "authError"))).toMatchObject({ code: "yt_thumb_auth" });
    expect(classifyThumbnailError(apiError(403, "insufficientPermissions"))).toMatchObject({ code: "yt_thumb_auth" });
  });
  it("404 : délai de propagation juste après l'envoi, vidéo supprimée sinon", () => {
    expect(classifyThumbnailError(apiError(404, "videoNotFound"), { justUploaded: true })).toMatchObject({
      retryable: true,
      code: "yt_thumb_video_not_ready",
    });
    expect(classifyThumbnailError(apiError(404, "videoNotFound"))).toMatchObject({ retryable: false, code: "yt_thumb_video_not_found" });
  });
  it("erreur réseau (délai dépassé, fetch failed) : nouvel essai", () => {
    const timeout = new Error("The operation was aborted due to timeout");
    timeout.name = "TimeoutError";
    expect(classifyThumbnailError(timeout)).toMatchObject({ retryable: true, code: "yt_thumb_network" });
    expect(classifyThumbnailError(new TypeError("fetch failed"))).toMatchObject({ retryable: true, code: "yt_thumb_network" });
  });
  it("image locale illisible ou trop lourde : jamais retentée, message tel quel", () => {
    expect(classifyThumbnailError(new ThumbnailImageError("Image illisible"))).toEqual({
      retryable: false,
      code: "yt_thumb_image",
      message: "Image illisible",
    });
  });
});

describe("messages", () => {
  it("nouvel essai : heure locale de l'utilisateur", () => {
    const failure = { retryable: true, code: "yt_thumb_server_error", message: "Erreur serveur YouTube (503)." };
    // 13/10/2026 15:05 UTC = 17:05 à Paris (heure d'été).
    expect(pendingRetryMessage(failure, new Date("2026-10-13T15:05:00Z"), "Europe/Paris")).toBe(
      "Erreur serveur YouTube (503). Nouvel essai automatique vers 17:05."
    );
  });
  it("échec final : précise si le nouvel essai a aussi échoué", () => {
    const failure = { retryable: true, code: "yt_thumb_server_error", message: "Erreur serveur YouTube (503)." };
    expect(finalFailureMessage(failure, false)).toBe("Erreur serveur YouTube (503).");
    expect(finalFailureMessage(failure, true)).toMatch(/échec aussi au nouvel essai/);
  });
});

describe("readThumbnailUrls", () => {
  it("ne garde que les tailles connues avec une URL", () => {
    expect(
      readThumbnailUrls({
        default: { url: "https://i.ytimg.com/vi/abc/default.jpg", width: 120, height: 90 },
        maxres: { url: "https://i.ytimg.com/vi/abc/maxresdefault.jpg" },
        weird: { url: "https://x" },
        high: { width: 480 },
      })
    ).toEqual({
      default: "https://i.ytimg.com/vi/abc/default.jpg",
      maxres: "https://i.ytimg.com/vi/abc/maxresdefault.jpg",
    });
    expect(readThumbnailUrls(null)).toEqual({});
  });
});

describe("thumbnailStillNeeded (purge des médias)", () => {
  it("une image de miniature en attente ou en échec est gardée ; posée, elle suit la règle commune", () => {
    expect(thumbnailStillNeeded(["PENDING"])).toBe(true);
    expect(thumbnailStillNeeded(["SET", "FAILED"])).toBe(true);
    expect(thumbnailStillNeeded(["SET", null])).toBe(false);
    expect(thumbnailStillNeeded([])).toBe(false);
  });
});

describe("processingDecision (attente du traitement de la vidéo)", () => {
  it("traitée → envoi ; en cours → attendre ; échec YouTube → abandon ; plafond atteint → dernier essai", () => {
    expect(processingDecision("processed", 1)).toBe("apply");
    expect(processingDecision("uploaded", 1)).toBe("wait");
    expect(processingDecision(undefined, 5)).toBe("wait");
    expect(processingDecision("failed", 1)).toBe("video_failed");
    expect(processingDecision("rejected", 3)).toBe("video_failed");
    expect(processingDecision("uploaded", PROCESSING_MAX_CHECKS)).toBe("give_up");
  });
});

describe("miniature par l'API pour les Shorts : coupée par défaut (14/10/2026)", () => {
  it("Short : refusée sans la variable, autorisée avec YOUTUBE_SHORTS_THUMBNAIL_API=1 ; autre contenu : toujours autorisée", () => {
    const saved = process.env.YOUTUBE_SHORTS_THUMBNAIL_API;
    try {
      delete process.env.YOUTUBE_SHORTS_THUMBNAIL_API;
      expect(thumbnailApiAllowed("YOUTUBE_SHORT")).toBe(false);
      expect(thumbnailApiAllowed("YOUTUBE_VIDEO")).toBe(true);
      process.env.YOUTUBE_SHORTS_THUMBNAIL_API = "1";
      expect(thumbnailApiAllowed("YOUTUBE_SHORT")).toBe(true);
      expect(SHORTS_THUMBNAIL_DISABLED_MESSAGE).toMatch(/YouTube Studio sur ordinateur/);
    } finally {
      if (saved === undefined) delete process.env.YOUTUBE_SHORTS_THUMBNAIL_API;
      else process.env.YOUTUBE_SHORTS_THUMBNAIL_API = saved;
    }
  });
});
