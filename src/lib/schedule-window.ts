/**
 * Fenêtre morte nocturne 23 h–7 h (P1-3) — module PUR et client-safe.
 *
 * Le service Render dort de 23 h à 7 h (heure de Paris) pour économiser les heures d'instance
 * gratuites (voir CLAUDE.md §21). Une publication programmée dans ce créneau ne partira qu'au réveil
 * (~7 h 05, via la réconciliation). Ces helpers permettent à l'UI d'avertir l'utilisateur et de lui
 * proposer un horaire de réveil, sans jamais bloquer durement (il peut assumer le décalage).
 *
 * Aucun import serveur/db : formatInTimeZone/fromZonedTime (date-fns-tz) sont des fonctions pures,
 * utilisables côté client comme serveur.
 */
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";

/** Message d'avertissement prêt à afficher (identique aux 3 points d'entrée de programmation). */
export const QUIET_WINDOW_LABEL =
  "Le service dort de 23h à 7h : une publication programmée dans ce créneau ne partira qu'au réveil (vers 7h05).";

/**
 * Vrai si `date` tombe dans la fenêtre morte (heure LOCALE ≥ 23 h ou < 7 h dans `timezone`).
 * L'heure locale est lue via `formatInTimeZone(date, tz, "H")` (0–23), donc correcte quel que soit
 * le décalage/l'heure d'été.
 */
export function isInQuietWindow(date: Date, timezone: string): boolean {
  const hour = Number(formatInTimeZone(date, timezone, "H"));
  return hour >= 23 || hour < 7;
}

/**
 * Incrémente une date calendaire « yyyy-MM-dd » d'un jour, en pur calendaire (UTC, sans dépendre du
 * fuseau ni de l'heure d'été) — sert à obtenir « le lendemain » de façon déterministe.
 */
function addOneCalendarDay(isoDay: string): string {
  const [year, month, day] = isoDay.split("-").map(Number);
  const dt = new Date(Date.UTC(year, month - 1, day));
  dt.setUTCDate(dt.getUTCDate() + 1);
  return dt.toISOString().slice(0, 10);
}

/**
 * Renvoie l'instant (UTC) du prochain 07 h 10 LOCAL suivant `date` :
 *  - si `date` est en soirée (heure locale ≥ 23 h) → 07 h 10 le LENDEMAIN ;
 *  - si `date` est au petit matin (heure locale < 7 h) → 07 h 10 le MÊME jour ;
 *  - (hors fenêtre morte, on renvoie tout de même le 07 h 10 pertinent selon la même règle — l'UI
 *    n'appelle cette fonction que lorsqu'elle veut proposer un réveil, typiquement quand
 *    `isInQuietWindow` est vrai).
 *
 * Reconstruit l'instant via `fromZonedTime` (gère l'heure d'été correctement).
 */
export function suggestWakeTime(date: Date, timezone: string): Date {
  const hour = Number(formatInTimeZone(date, timezone, "H"));
  const localDay = formatInTimeZone(date, timezone, "yyyy-MM-dd");
  // ≥ 23 h : le réveil est le lendemain matin. < 23 h (petit matin ou reste de la journée) : même jour.
  const targetDay = hour >= 23 ? addOneCalendarDay(localDay) : localDay;
  return fromZonedTime(`${targetDay}T07:10:00`, timezone);
}
