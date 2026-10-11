import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SIGNED_URL_WINDOW_S, signedMediaExpiry, signedWorkerMediaUrl } from "./media-url";

describe("liens signés du Worker", () => {
  const now = Date.UTC(2026, 9, 11, 20, 30);

  it("expiration stable dans une fenêtre de 12 h et valable 12 à 24 h", () => {
    const exp = signedMediaExpiry(now);
    expect(exp % SIGNED_URL_WINDOW_S).toBe(0);
    expect(signedMediaExpiry(now + 60_000)).toBe(exp);
    const remaining = exp - now / 1000;
    expect(remaining).toBeGreaterThan(SIGNED_URL_WINDOW_S);
    expect(remaining).toBeLessThanOrEqual(2 * SIGNED_URL_WINDOW_S);
  });

  it("signature = HMAC-SHA256 de « clé\\nexp », comme le Worker la vérifie", () => {
    const key = "media/u1/abc-video.mp4";
    const url = new URL(signedWorkerMediaUrl("https://w.example.dev/", "s3cret", key, now));
    expect(url.origin + url.pathname).toBe("https://w.example.dev/m/media/u1/abc-video.mp4");
    const exp = url.searchParams.get("exp")!;
    const expected = createHmac("sha256", "s3cret").update(`${key}\n${exp}`).digest("hex");
    expect(url.searchParams.get("sig")).toBe(expected);
  });

  it("encode chaque segment de la clé sans toucher aux séparateurs", () => {
    const url = signedWorkerMediaUrl("https://w.example.dev", "s", "media/u1/a b#c.jpg", now);
    expect(url).toContain("/m/media/u1/a%20b%23c.jpg?");
  });
});
