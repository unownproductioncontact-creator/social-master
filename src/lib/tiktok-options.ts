/**
 * Options d'une cible TikTok stockées dans `PostTarget.platformOptions` (CLAUDE.md §41) — module PUR,
 * importable côté client (composer) comme côté serveur.
 *
 * Moment du dépôt du brouillon dans la boîte de réception TikTok :
 *  - « scheduled » (défaut depuis le 23/10/2026, demande du user) : à l'heure prévue de la cible, comme
 *    Instagram — le brouillon arrive quand il faut le publier (avec la notif Telegram et la légende) ;
 *  - « now » : dès la programmation (ancien comportement), pour l'avoir tout de suite dans l'app.
 * On n'écrit `draftTiming` que pour « now » : une cible sans option = défaut.
 */

export const TIKTOK_DRAFT_TIMINGS = ["scheduled", "now"] as const;
export type TikTokDraftTiming = (typeof TIKTOK_DRAFT_TIMINGS)[number];

export const TIKTOK_DRAFT_TIMING_LABELS: Record<TikTokDraftTiming, string> = {
  scheduled: "À l’heure prévue",
  now: "Dès la programmation",
};

/** Lecture tolérante : tout ce qui n'est pas « now » = à l'heure prévue. */
export function tiktokDraftTimingFromOptions(options: unknown): TikTokDraftTiming {
  if (typeof options !== "object" || options === null) return "scheduled";
  return (options as { draftTiming?: unknown }).draftTiming === "now" ? "now" : "scheduled";
}

/** platformOptions d'une cible TikTok : on n'écrit que ce qui diffère du défaut. */
export function buildTikTokOptions(timing: TikTokDraftTiming): Record<string, string> {
  return timing === "now" ? { draftTiming: "now" } : {};
}
