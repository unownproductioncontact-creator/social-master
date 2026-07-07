import { describe, it, expect } from "vitest";
import { classifyInstagramError, classifyTikTokError, needsReauth } from "@/lib/errors";

describe("classifyInstagramError", () => {
  it("classe une erreur de container non prêt comme transitoire", () => {
    const result = classifyInstagramError(new Error("Container Instagram en échec : (9007)"));
    expect(result.errorClass).toBe("transient");
    expect(result.code).toBe("ig_not_ready");
  });

  it("classe un quota atteint comme account_issue", () => {
    const result = classifyInstagramError(new Error("code 2207042 quota"));
    expect(result.errorClass).toBe("account_issue");
    expect(result.code).toBe("ig_quota");
  });

  it("classe un token invalide (190) comme account_issue nécessitant une reconnexion", () => {
    const result = classifyInstagramError(new Error("OAuthException code 190 Invalid access token"));
    expect(result.errorClass).toBe("account_issue");
    expect(result.code).toBe("ig_token_invalid");
    expect(needsReauth(result.code)).toBe(true);
  });

  it("classe un contenu invalide (36000-series) comme content_rejected", () => {
    const result = classifyInstagramError(new Error("2207004 invalid aspect ratio"));
    expect(result.errorClass).toBe("content_rejected");
    expect(result.code).toBe("ig_media_invalid");
  });

  it("classe un rate limit comme transitoire", () => {
    const result = classifyInstagramError(new Error("429 Too Many Requests"));
    expect(result.errorClass).toBe("transient");
    expect(result.code).toBe("ig_rate_limited");
  });

  it("retombe sur transient/ig_unknown pour une erreur non reconnue", () => {
    const result = classifyInstagramError(new Error("something completely unexpected"));
    expect(result.errorClass).toBe("transient");
    expect(result.code).toBe("ig_unknown");
  });

  it("gère une valeur qui n'est pas une instance d'Error", () => {
    const result = classifyInstagramError("just a string with 190 in it");
    expect(result.code).toBe("ig_token_invalid");
  });
});

describe("classifyTikTokError", () => {
  it("classe spam_risk_too_many_posts comme quota (account_issue)", () => {
    const result = classifyTikTokError(new Error("spam_risk_too_many_posts"));
    expect(result.errorClass).toBe("account_issue");
    expect(result.code).toBe("tt_quota");
    expect(needsReauth(result.code)).toBe(false);
  });

  it("classe spam_risk_user_banned_from_posting comme nécessitant une reconnexion", () => {
    const result = classifyTikTokError(new Error("spam_risk_user_banned_from_posting"));
    expect(result.code).toBe("tt_banned");
    expect(needsReauth(result.code)).toBe(true);
  });

  it("classe access_token_invalid comme nécessitant une reconnexion", () => {
    const result = classifyTikTokError(new Error("access_token_invalid"));
    expect(result.code).toBe("tt_token_invalid");
    expect(needsReauth(result.code)).toBe(true);
  });

  it("classe url_ownership_unverified comme content_rejected (jamais retenté)", () => {
    const result = classifyTikTokError(new Error("url_ownership_unverified"));
    expect(result.errorClass).toBe("content_rejected");
  });

  it("retombe sur transient/tt_unknown pour une erreur non reconnue", () => {
    const result = classifyTikTokError(new Error("mystery failure"));
    expect(result.errorClass).toBe("transient");
    expect(result.code).toBe("tt_unknown");
  });
});

describe("needsReauth", () => {
  it("retourne false pour un code inconnu", () => {
    expect(needsReauth("not_a_real_code")).toBe(false);
  });
});
