import { describe, it, expect, afterEach } from "vitest";
import { appUrl } from "@/lib/app-url";

const ORIGINAL = process.env.APP_URL;
afterEach(() => {
  process.env.APP_URL = ORIGINAL;
});

describe("appUrl", () => {
  it("retire un slash final unique (cause du mismatch redirect_uri TikTok)", () => {
    process.env.APP_URL = "https://social-master-jitq.onrender.com/";
    expect(appUrl()).toBe("https://social-master-jitq.onrender.com");
  });

  it("retire plusieurs slashs finaux", () => {
    process.env.APP_URL = "https://example.com///";
    expect(appUrl()).toBe("https://example.com");
  });

  it("laisse intacte une URL sans slash final", () => {
    process.env.APP_URL = "https://example.com";
    expect(appUrl()).toBe("https://example.com");
  });

  it("ne touche pas aux slashs internes du chemin", () => {
    process.env.APP_URL = "https://example.com/base/";
    expect(appUrl()).toBe("https://example.com/base");
  });

  it("APP_URL absent → chaîne vide (pas de crash)", () => {
    delete process.env.APP_URL;
    expect(appUrl()).toBe("");
  });
});
