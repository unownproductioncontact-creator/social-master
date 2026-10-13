import { describe, expect, it } from "vitest";
import { coverPlan, coverTimeFromOptions, readCoverResult } from "@/lib/instagram-cover";

const image = { id: "img1", storageKey: "media/u/cover.jpg", mimeType: "image/jpeg", status: "READY" };

describe("coverPlan (couverture d'un Reel)", () => {
  it("hors Reel : rien n'est envoyé", () => {
    expect(coverPlan("IMAGE", { coverTimeMs: 900 }, image)).toEqual({ coverMedia: null });
    expect(coverPlan("STORY", {}, image)).toEqual({ coverMedia: null });
  });

  it("image choisie : cover_url, et la frame éventuelle reste envoyée en repli", () => {
    expect(coverPlan("REEL", { coverTimeMs: 900 }, image)).toEqual({
      coverMedia: image,
      thumbOffsetMs: 900,
      result: { applied: "cover_url", mediaId: "img1" },
    });
  });

  it("image déjà refusée par Instagram (essai précédent) : frame seulement", () => {
    expect(coverPlan("REEL", { coverRefused: "container_error", coverTimeMs: 900 }, image)).toEqual({
      coverMedia: null,
      thumbOffsetMs: 900,
      result: { applied: "frame", reason: "cover_refused", thumbOffsetMs: 900 },
    });
  });

  it("média qui n'est pas une image prête : ignoré", () => {
    expect(coverPlan("REEL", {}, { ...image, mimeType: "video/mp4" })).toEqual({ coverMedia: null, thumbOffsetMs: undefined, result: undefined });
    expect(coverPlan("REEL", {}, { ...image, status: "UPLOADING" }).coverMedia).toBeNull();
  });

  it("sans image : frame si choisie, sinon rien à signaler", () => {
    expect(coverPlan("REEL", { coverTimeMs: 1200.4 }, null)).toEqual({
      coverMedia: null,
      thumbOffsetMs: 1200,
      result: { applied: "frame", thumbOffsetMs: 1200 },
    });
    expect(coverPlan("REEL", {}, null)).toEqual({ coverMedia: null, thumbOffsetMs: undefined, result: undefined });
  });
});

describe("lectures tolérantes", () => {
  it("coverTimeFromOptions", () => {
    expect(coverTimeFromOptions({ coverTimeMs: 0 })).toBe(0);
    expect(coverTimeFromOptions({ coverTimeMs: -5 })).toBeUndefined();
    expect(coverTimeFromOptions({ coverTimeMs: "900" })).toBeUndefined();
    expect(coverTimeFromOptions(null)).toBeUndefined();
  });

  it("readCoverResult (journal de publication)", () => {
    expect(readCoverResult({ cover: { applied: "cover_url", mediaId: "img1" } })).toEqual({ applied: "cover_url", mediaId: "img1" });
    expect(readCoverResult({ cover: { applied: "autre" } })).toBeNull();
    expect(readCoverResult({ delivery: {} })).toBeNull();
  });
});
