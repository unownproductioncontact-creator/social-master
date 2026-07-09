import { describe, it, expect } from "vitest";
import { classifyInstagramError, classifyTikTokError, needsReauth } from "@/lib/errors";

describe("classifyInstagramError", () => {
  // Reproduit le vrai message levé par graphFetch : "... (${status}): ${corps JSON brut Meta}".
  const igError = (code: number, subcode?: number, fbtrace = "A1b2C3d4") =>
    new Error(
      `Graph API Instagram échouée (400): {"error":{"message":"boom","code":${code}` +
        (subcode != null ? `,"error_subcode":${subcode}` : "") +
        `,"fbtrace_id":"${fbtrace}"}}`
    );

  it("média pas prêt (9007/2207027) → transitoire", () => {
    const r = classifyInstagramError(igError(9007, 2207027));
    expect(r.errorClass).toBe("transient");
    expect(r.code).toBe("ig_not_ready");
  });

  it("quota (9/2207042) → account_issue", () => {
    const r = classifyInstagramError(igError(9, 2207042));
    expect(r.errorClass).toBe("account_issue");
    expect(r.code).toBe("ig_quota");
  });

  it("token invalide (190) → account_issue + reconnexion", () => {
    const r = classifyInstagramError(igError(190, 463));
    expect(r.errorClass).toBe("account_issue");
    expect(r.code).toBe("ig_token_invalid");
    expect(needsReauth(r.code)).toBe(true);
  });

  it("média non conforme (36000/2207004) → content_rejected", () => {
    const r = classifyInstagramError(igError(36000, 2207004));
    expect(r.errorClass).toBe("content_rejected");
    expect(r.code).toBe("ig_media_invalid");
  });

  it("spam (4/2207051) → content_rejected (pas un rate-limit pour Instagram)", () => {
    const r = classifyInstagramError(igError(4, 2207051));
    expect(r.errorClass).toBe("content_rejected");
    expect(r.code).toBe("ig_spam_flag");
  });

  it("rate-limit app-level (17) → transitoire", () => {
    const r = classifyInstagramError(igError(17));
    expect(r.errorClass).toBe("transient");
    expect(r.code).toBe("ig_rate_limited");
  });

  // RÉGRESSION du bug audité le 09/07 : des chiffres présents dans le fbtrace_id (chaîne opaque) ne
  // doivent JAMAIS déclencher une classification. Ici code=-1 (transitoire) mais fbtrace contient 190/458.
  it("chiffres 190/458 dans le fbtrace_id → NE déclenche PAS ig_token_invalid", () => {
    const r = classifyInstagramError(igError(-1, undefined, "A190x458Z"));
    expect(r.code).toBe("ig_unknown");
    expect(r.errorClass).toBe("transient");
  });

  it("marqueur interne container ERROR → content_rejected (pas de retry)", () => {
    const r = classifyInstagramError(new Error("ig_container_error: le conteneur a échoué"));
    expect(r.errorClass).toBe("content_rejected");
    expect(r.code).toBe("ig_media_invalid");
  });

  it("marqueurs internes container EXPIRED / timeout → transitoire", () => {
    expect(classifyInstagramError(new Error("ig_container_expired: >24h")).errorClass).toBe("transient");
    expect(classifyInstagramError(new Error("ig_container_timeout: délai dépassé")).errorClass).toBe("transient");
  });

  it("erreur non reconnue → transient/ig_unknown", () => {
    const r = classifyInstagramError(new Error("something completely unexpected"));
    expect(r.errorClass).toBe("transient");
    expect(r.code).toBe("ig_unknown");
  });

  it("chaîne sans corps d'erreur structuré → ig_unknown (plus de faux-match sur un 190 nu)", () => {
    const r = classifyInstagramError("just a string with 190 in it");
    expect(r.code).toBe("ig_unknown");
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
