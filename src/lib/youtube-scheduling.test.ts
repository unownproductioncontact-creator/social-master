import { describe, expect, it } from "vitest";
import {
  CONFIRM_MAX_CHECKS,
  confirmDecision,
  NATIVE_SCHEDULE_MIN_LEAD_MS,
  schedulesOnYouTube,
  uploadAsScheduled,
} from "@/lib/youtube-scheduling";

const now = new Date("2026-10-14T10:00:00Z");
const inMinutes = (m: number) => new Date(now.getTime() + m * 60_000);

describe("schedulesOnYouTube (à la programmation)", () => {
  it("vidéo publique programmée au moins 15 min à l'avance → confiée à YouTube", () => {
    expect(schedulesOnYouTube({ privacy: "public", publishAt: inMinutes(15), now, immediate: false })).toBe(true);
    expect(schedulesOnYouTube({ privacy: "public", publishAt: inMinutes(24 * 60), now, immediate: false })).toBe(true);
  });
  it("moins de 15 min, « Publier maintenant », non répertoriée ou privée → publication directe à l'heure", () => {
    expect(schedulesOnYouTube({ privacy: "public", publishAt: new Date(now.getTime() + NATIVE_SCHEDULE_MIN_LEAD_MS - 1), now, immediate: false })).toBe(false);
    expect(schedulesOnYouTube({ privacy: "public", publishAt: inMinutes(60), now, immediate: true })).toBe(false);
    expect(schedulesOnYouTube({ privacy: "unlisted", publishAt: inMinutes(60), now, immediate: false })).toBe(false);
    expect(schedulesOnYouTube({ privacy: "private", publishAt: inMinutes(60), now, immediate: false })).toBe(false);
  });
});

describe("uploadAsScheduled (au moment de l'envoi)", () => {
  it("envoi anticipé : privée + publishAt", () => {
    expect(uploadAsScheduled("public", inMinutes(30), now)).toBe(true);
  });
  it("job « à l'heure » ou arrivé trop tard : publication directe", () => {
    expect(uploadAsScheduled("public", now, now)).toBe(false);
    expect(uploadAsScheduled("public", inMinutes(-5), now)).toBe(false);
    expect(uploadAsScheduled("public", new Date(now.getTime() + 30_000), now)).toBe(false);
    expect(uploadAsScheduled("public", null, now)).toBe(false);
    expect(uploadAsScheduled("unlisted", inMinutes(30), now)).toBe(false);
  });
});

describe("confirmDecision (vérification à l'heure prévue)", () => {
  it("publique → published ; introuvable → missing", () => {
    expect(confirmDecision({ privacyStatus: "public" }, 1, now)).toBe("published");
    expect(confirmDecision(null, 1, now)).toBe("missing");
  });
  it("encore privée : on revérifie, puis abandon au plafond", () => {
    expect(confirmDecision({ privacyStatus: "private", publishAt: inMinutes(-1).toISOString() }, 1, now)).toBe("wait");
    expect(confirmDecision({ privacyStatus: "private" }, CONFIRM_MAX_CHECKS, now)).toBe("give_up");
  });
  it("date déplacée plus tard dans Studio : on suit la nouvelle heure, même au plafond", () => {
    expect(confirmDecision({ privacyStatus: "private", publishAt: inMinutes(90).toISOString() }, CONFIRM_MAX_CHECKS, now)).toBe("moved");
  });
});
