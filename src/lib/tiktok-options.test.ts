import { describe, expect, it } from "vitest";
import { buildTikTokOptions, tiktokDraftTimingFromOptions } from "@/lib/tiktok-options";

describe("moment du dépôt d'un brouillon TikTok (§41)", () => {
  it("défaut = à l'heure prévue ; « now » seulement si demandé explicitement", () => {
    expect(tiktokDraftTimingFromOptions(null)).toBe("scheduled");
    expect(tiktokDraftTimingFromOptions({})).toBe("scheduled");
    expect(tiktokDraftTimingFromOptions({ draftTiming: "bizarre" })).toBe("scheduled");
    expect(tiktokDraftTimingFromOptions({ draftTiming: "now" })).toBe("now");
  });

  it("on n'écrit l'option que pour un dépôt immédiat", () => {
    expect(buildTikTokOptions("scheduled")).toEqual({});
    expect(buildTikTokOptions("now")).toEqual({ draftTiming: "now" });
    expect(tiktokDraftTimingFromOptions(buildTikTokOptions("now"))).toBe("now");
  });
});
