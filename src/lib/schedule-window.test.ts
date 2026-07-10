import { describe, it, expect } from "vitest";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { isInQuietWindow, suggestWakeTime, QUIET_WINDOW_LABEL } from "@/lib/schedule-window";

const TZ = "Europe/Paris";

/** Fabrique un instant UTC à partir d'une heure locale Paris (gère CET/CEST). */
function parisLocal(iso: string): Date {
  return fromZonedTime(iso, TZ);
}

/** Rend l'instant en heure locale Paris « yyyy-MM-dd HH:mm » pour des assertions robustes au fuseau. */
function asParis(date: Date): string {
  return formatInTimeZone(date, TZ, "yyyy-MM-dd HH:mm");
}

describe("isInQuietWindow", () => {
  it("23:30 est DANS la fenêtre morte", () => {
    expect(isInQuietWindow(parisLocal("2026-07-15T23:30:00"), TZ)).toBe(true);
  });

  it("02:00 est DANS la fenêtre morte", () => {
    expect(isInQuietWindow(parisLocal("2026-07-15T02:00:00"), TZ)).toBe(true);
  });

  it("22:59 est HORS de la fenêtre morte (bord bas exclusif à 23h)", () => {
    expect(isInQuietWindow(parisLocal("2026-07-15T22:59:00"), TZ)).toBe(false);
  });

  it("07:00 est HORS de la fenêtre morte (réveil pile)", () => {
    expect(isInQuietWindow(parisLocal("2026-07-15T07:00:00"), TZ)).toBe(false);
  });

  it("23:00 pile est DANS la fenêtre morte, 06:59 aussi", () => {
    expect(isInQuietWindow(parisLocal("2026-07-15T23:00:00"), TZ)).toBe(true);
    expect(isInQuietWindow(parisLocal("2026-07-15T06:59:00"), TZ)).toBe(true);
  });
});

describe("suggestWakeTime", () => {
  it("soirée (23:30) → 07:10 le LENDEMAIN", () => {
    const wake = suggestWakeTime(parisLocal("2026-07-15T23:30:00"), TZ);
    expect(asParis(wake)).toBe("2026-07-16 07:10");
  });

  it("petit matin (02:00) → 07:10 le MÊME jour", () => {
    const wake = suggestWakeTime(parisLocal("2026-07-15T02:00:00"), TZ);
    expect(asParis(wake)).toBe("2026-07-15 07:10");
  });

  it("HEURE D'HIVER (janvier, CET/UTC+1) : 23:30 → lendemain 07:10 local", () => {
    const src = parisLocal("2026-01-15T23:30:00");
    const wake = suggestWakeTime(src, TZ);
    expect(asParis(wake)).toBe("2026-01-16 07:10");
    // En CET (UTC+1), 07:10 local = 06:10 UTC.
    expect(wake.toISOString()).toBe("2026-01-16T06:10:00.000Z");
  });

  it("HEURE D'ÉTÉ (juillet, CEST/UTC+2) : 23:30 → lendemain 07:10 local", () => {
    const src = parisLocal("2026-07-15T23:30:00");
    const wake = suggestWakeTime(src, TZ);
    expect(asParis(wake)).toBe("2026-07-16 07:10");
    // En CEST (UTC+2), 07:10 local = 05:10 UTC.
    expect(wake.toISOString()).toBe("2026-07-16T05:10:00.000Z");
  });

  it("le réveil proposé n'est jamais lui-même dans la fenêtre morte", () => {
    for (const iso of ["2026-01-15T23:30:00", "2026-07-15T02:00:00", "2026-07-15T23:59:00"]) {
      expect(isInQuietWindow(suggestWakeTime(parisLocal(iso), TZ), TZ)).toBe(false);
    }
  });

  it("passage de fin de mois : 31 janvier 23:30 → 1er février 07:10", () => {
    const wake = suggestWakeTime(parisLocal("2026-01-31T23:30:00"), TZ);
    expect(asParis(wake)).toBe("2026-02-01 07:10");
  });
});

describe("QUIET_WINDOW_LABEL", () => {
  it("mentionne le créneau 23h–7h et le réveil ~7h05", () => {
    expect(QUIET_WINDOW_LABEL).toContain("23h");
    expect(QUIET_WINDOW_LABEL).toContain("7h");
    expect(QUIET_WINDOW_LABEL).toContain("7h05");
  });
});
