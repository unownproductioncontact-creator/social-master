import { describe, expect, it } from "vitest";
import { buildYouTubeOptions, youtubePrivacyFromOptions, youtubeTitleFromOptions } from "@/lib/youtube-options";

describe("options d'une cible YouTube", () => {
  it("visibilité : public par défaut, valeurs inconnues ignorées", () => {
    expect(youtubePrivacyFromOptions({})).toBe("public");
    expect(youtubePrivacyFromOptions(null)).toBe("public");
    expect(youtubePrivacyFromOptions({ privacy: "unlisted" })).toBe("unlisted");
    expect(youtubePrivacyFromOptions({ privacy: "private" })).toBe("private");
    expect(youtubePrivacyFromOptions({ privacy: "secret" })).toBe("public");
  });

  it("n'écrit que ce qui diffère du défaut (titre saisi, visibilité non publique)", () => {
    expect(buildYouTubeOptions(null, "public")).toEqual({});
    expect(buildYouTubeOptions("Mon Short", "public")).toEqual({ title: "Mon Short" });
    expect(buildYouTubeOptions(undefined, "unlisted")).toEqual({ privacy: "unlisted" });
    expect(buildYouTubeOptions("T", "private")).toEqual({ title: "T", privacy: "private" });
  });

  it("titre : lecture tolérante", () => {
    expect(youtubeTitleFromOptions({ title: "Mon Short" })).toBe("Mon Short");
    expect(youtubeTitleFromOptions({ title: "  " })).toBeUndefined();
    expect(youtubeTitleFromOptions({ title: 3 })).toBeUndefined();
  });
});
