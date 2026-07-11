// Logique PURE d'UI pour la page « Publication en masse » (/composer/bulk).
//
// Aucun accès réseau/DB/DOM ici — uniquement des transformations de valeurs, pour que tout soit
// testable unitairement (bulk-ui.test.ts). Les composants client (bulk-composer.tsx, bulk-card.tsx)
// importent ces fonctions pour l'application groupée (légende/hashtags communs), l'espacement des
// horaires, la conversion fuseau-aware et le calcul des horaires effectifs par carte.
//
// Convention de date côté UI : on manipule des chaînes `datetime-local` au format
// « yyyy-MM-ddTHH:mm » (ce que produit/consomme un <input type="datetime-local">), interprétées
// dans le fuseau de l'utilisateur au moment de la soumission (jamais ici). Espacer les vidéos revient
// donc à additionner des minutes à cette heure locale « murale » — sans conversion de fuseau, ce qui
// est exactement le comportement attendu par l'utilisateur qui voit ces champs. Plus bas, une AUTRE
// famille de fonctions (localToDate et consorts) fait la VRAIE conversion de fuseau (date-fns-tz),
// nécessaire pour soumettre au serveur et pour comparer un horaire à la fenêtre morte du service.

import { fromZonedTime, formatInTimeZone } from "date-fns-tz";
import { isInQuietWindow } from "@/lib/schedule-window";

/**
 * Découpe une saisie de hashtags en tokens normalisés, EXACTEMENT comme le composer mono-post
 * (post-composer-form.tsx) : séparateurs espaces/virgules/retours ligne, retrait du « # » de tête,
 * trim, suppression des vides. Aucune limite ici (les règles métier vivent côté serveur).
 */
export function splitHashtags(input: string): string[] {
  return input
    .split(/[\s,]+/)
    .map((h) => h.trim().replace(/^#+/, ""))
    .filter(Boolean);
}

/** Recompose une liste de hashtags en une chaîne éditable (séparés par des espaces, sans « # »). */
export function joinHashtags(hashtags: string[]): string {
  return hashtags.join(" ");
}

/**
 * Fusionne deux listes de hashtags en préservant l'ordre et en dédupliquant (insensible à la casse
 * pour la détection de doublon, mais on garde la première graphie rencontrée). Utilisé par le mode
 * « ajouter » de l'application groupée.
 */
export function mergeHashtags(existing: string[], toAdd: string[]): string[] {
  const seen = new Set(existing.map((h) => h.toLowerCase()));
  const result = [...existing];
  for (const tag of toAdd) {
    const key = tag.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(tag);
    }
  }
  return result;
}

/**
 * Applique des hashtags communs à une liste de listes de hashtags (une par carte), selon le mode :
 *  - « replace » : chaque carte reçoit EXACTEMENT `common` (remplace tout).
 *  - « append »  : chaque carte conserve les siens + `common` (fusion dédupliquée par mergeHashtags).
 *
 * Fonction pure : renvoie un NOUVEAU tableau, n'altère pas l'entrée.
 */
export type HashtagApplyMode = "append" | "replace";

export function applyGroupHashtags(
  perCard: string[][],
  common: string[],
  mode: HashtagApplyMode
): string[][] {
  return perCard.map((cardTags) =>
    mode === "replace" ? [...common] : mergeHashtags(cardTags, common)
  );
}

// -----------------------------------------------------------------------------
// Espacement des horaires (« vidéo 1 à H, vidéo 2 à H+N, … »)
// -----------------------------------------------------------------------------

const DATETIME_LOCAL_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/** Vrai si `value` est une chaîne datetime-local exploitable (« yyyy-MM-ddTHH:mm », date réelle). */
export function isValidDateTimeLocal(value: string): boolean {
  if (!DATETIME_LOCAL_RE.test(value)) return false;
  // On reconstruit la date en composants pour rejeter les valeurs syntaxiquement correctes mais
  // impossibles (ex. « 2026-02-31T10:00 »). On compare les champs après normalisation.
  const [datePart, timePart] = value.split("T");
  const [y, mo, d] = datePart.split("-").map(Number);
  const [h, mi] = timePart.split(":").map(Number);
  const dt = new Date(y, mo - 1, d, h, mi);
  return (
    dt.getFullYear() === y &&
    dt.getMonth() === mo - 1 &&
    dt.getDate() === d &&
    dt.getHours() === h &&
    dt.getMinutes() === mi
  );
}

/**
 * Convertit une chaîne datetime-local en horodatage « minutes depuis l'epoch local » manipulable
 * arithmétiquement (on reste en heure murale : `new Date(y, mo-1, d, h, mi)` interprète dans le
 * fuseau local du runtime). Renvoie NaN si invalide.
 */
function dateTimeLocalToMs(value: string): number {
  if (!isValidDateTimeLocal(value)) return Number.NaN;
  const [datePart, timePart] = value.split("T");
  const [y, mo, d] = datePart.split("-").map(Number);
  const [h, mi] = timePart.split(":").map(Number);
  return new Date(y, mo - 1, d, h, mi).getTime();
}

/** Reformate un timestamp local (ms) en chaîne datetime-local « yyyy-MM-ddTHH:mm ». */
export function msToDateTimeLocal(ms: number): string {
  const dt = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}` +
    `T${pad(dt.getHours())}:${pad(dt.getMinutes())}`
  );
}

/**
 * Calcule les horaires espacés de `count` cartes : la carte i (0-indexée) part à
 * `start + i * intervalMinutes`. Renvoie un tableau de chaînes datetime-local (même format que
 * l'input), prêt à être injecté dans chaque carte.
 *
 *  - `start` : chaîne datetime-local de départ (heure de la première vidéo).
 *  - `intervalMinutes` : entier ≥ 0. 0 = toutes les cartes à la même heure.
 *  - `count` : nombre de cartes (≥ 0).
 *
 * Renvoie `{ error }` si `start` est invalide ou `intervalMinutes` négatif/non fini — l'appelant
 * affiche l'erreur au lieu d'écraser les horaires avec des valeurs absurdes.
 */
export type SpacedTimesResult = { times: string[] } | { error: string };

export function computeSpacedTimes(
  start: string,
  intervalMinutes: number,
  count: number
): SpacedTimesResult {
  const startMs = dateTimeLocalToMs(start);
  if (Number.isNaN(startMs)) {
    return { error: "Heure de départ invalide." };
  }
  if (!Number.isFinite(intervalMinutes) || intervalMinutes < 0) {
    return { error: "Intervalle invalide (minutes ≥ 0)." };
  }
  const step = Math.round(intervalMinutes) * 60_000;
  const times: string[] = [];
  for (let i = 0; i < Math.max(0, count); i++) {
    times.push(msToDateTimeLocal(startMs + i * step));
  }
  return { times };
}

// -----------------------------------------------------------------------------
// Validation client d'une carte (miroir léger des règles serveur, messages FR alignés)
// -----------------------------------------------------------------------------

/**
 * Marge minimale (en ms) entre « maintenant » et l'heure de publication d'une carte, côté client.
 * Le serveur exige ≥ 60 s (scheduler.ts) ; on prend une marge plus large (2 min) pour absorber le
 * temps de soumission du lot et éviter un refus serveur juste après validation client.
 */
export const MIN_LEAD_MS = 2 * 60 * 1000;

// `youtube` optionnel (défaut = non ciblé) : rétrocompatible avec les cartes UI existantes qui ne
// portent encore que { tiktok, instagram } (le câblage de la case YouTube est hors de ce lot).
export type CardPlatforms = { tiktok: boolean; instagram: boolean; youtube?: boolean };

export type CardValidationInput = {
  mediaCount: number;
  caption: string;
  platforms: CardPlatforms;
  /** Heure de publication en ms (déjà résolue depuis le datetime-local dans le fuseau utilisateur). */
  scheduledMs: number;
};

/**
 * Valide une carte AVANT envoi. Renvoie `null` si tout est bon, sinon un message FR (le premier
 * problème rencontré). Aligné sur les règles réelles :
 *  - au moins un média (bulk-scheduler `validateItem`),
 *  - au moins une plateforme cochée (TikTok, Instagram ou YouTube),
 *  - heure ≥ maintenant + MIN_LEAD_MS (marge de sécurité vs la règle serveur des 60 s),
 *  - légende non vide si Instagram est ciblé (exigence produit : un post IG sans légende n'a pas de
 *    sens ; côté serveur la légende reste optionnelle mais le produit l'impose ici pour Instagram).
 *    YouTube n'impose AUCUNE règle de légende ici : le titre est auto en masse (1re ligne de légende
 *    reconstruite par le worker),
 *  - légende ≤ 2200 caractères (limite commune IG/TikTok).
 */
export function validateCard(input: CardValidationInput, now: number = Date.now()): string | null {
  if (input.mediaCount < 1) {
    return "Sélectionnez au moins un média.";
  }
  if (!input.platforms.tiktok && !input.platforms.instagram && !input.platforms.youtube) {
    return "Choisissez au moins une plateforme.";
  }
  if (!Number.isFinite(input.scheduledMs)) {
    return "Choisissez une date et une heure de publication.";
  }
  if (input.scheduledMs < now + MIN_LEAD_MS) {
    return "L'heure de publication doit être au moins 2 minutes dans le futur.";
  }
  if (input.caption.length > 2200) {
    return "2200 caractères maximum.";
  }
  if (input.platforms.instagram && input.caption.trim().length === 0) {
    return "Ajoutez une légende (obligatoire pour Instagram).";
  }
  return null;
}

// -----------------------------------------------------------------------------
// Conversion fuseau-aware datetime-local ↔ Date (bord réel avec le fuseau utilisateur, P3-5b)
// -----------------------------------------------------------------------------

/**
 * Convertit une chaîne datetime-local (heure murale dans `timezone`) en Date UTC via `fromZonedTime`.
 * Renvoie `null` si la chaîne est syntaxiquement invalide (voir isValidDateTimeLocal) ou si la
 * conversion échoue.
 */
export function localToDate(value: string, timezone: string): Date | null {
  if (!isValidDateTimeLocal(value)) return null;
  const utc = fromZonedTime(value, timezone);
  return Number.isNaN(utc.getTime()) ? null : utc;
}

/** Comme localToDate, mais renvoie des millisecondes epoch (NaN si invalide). */
export function localToMs(value: string, timezone: string): number {
  const date = localToDate(value, timezone);
  return date ? date.getTime() : Number.NaN;
}

/** Comme localToDate, mais renvoie une chaîne ISO 8601 prête pour une Server Action (null si invalide). */
export function localToIso(value: string, timezone: string): string | null {
  const date = localToDate(value, timezone);
  return date ? date.toISOString() : null;
}

/** Formate une Date UTC en chaîne datetime-local représentant l'heure murale dans `timezone`. */
export function dateToLocal(date: Date, timezone: string): string {
  return formatInTimeZone(date, timezone, "yyyy-MM-dd'T'HH:mm");
}

// -----------------------------------------------------------------------------
// Horaires effectifs par carte (P1-4 compteur TikTok fenêtré, P1-3 avertissement fenêtre morte)
// -----------------------------------------------------------------------------

export type BulkTimingMode = "offset" | "simultaneous" | "custom";

/** Sous-ensemble d'une carte utile au calcul des horaires effectifs (structurel : pas d'import de BulkCardState). */
export type CardTimeFields = {
  platforms: CardPlatforms;
  dateTime: string;
  tiktokTime: string;
  instagramTime: string;
  // Optionnel (mode custom uniquement) : horaire YouTube par carte, symétrique de tiktokTime/
  // instagramTime. Absent tant que l'UI n'expose pas la case YouTube (hors de ce lot).
  youtubeTime?: string;
};

/**
 * Horaire TikTok EFFECTIF (ms) d'une carte, selon le mode de timing du lot — même résolution que le
 * serveur (`computeTargetTimes` dans bulk-scheduler.ts : en offset/simultané TikTok part à l'horaire
 * de base `dateTime`, en custom il a son propre champ `tiktokTime`). Renvoie `null` si la carte ne
 * cible pas TikTok, ou si son horaire est vide/invalide — un item invalide échouera de toute façon à
 * la soumission (voir validateCard), ce calcul ne doit jamais jeter.
 */
export function effectiveTiktokTimeMs(
  card: CardTimeFields,
  timingMode: BulkTimingMode,
  timezone: string
): number | null {
  if (!card.platforms.tiktok) return null;
  const raw = timingMode === "custom" ? card.tiktokTime : card.dateTime;
  const ms = localToMs(raw, timezone);
  return Number.isFinite(ms) ? ms : null;
}

/** Un champ horaire d'une carte concerné par un contrôle (fenêtre morte…), avec son nom et sa valeur brute. */
export type TimedField = {
  field: "dateTime" | "tiktokTime" | "instagramTime" | "youtubeTime";
  value: string;
};

/**
 * Champs horaires PERTINENTS d'une carte selon le mode de timing et les plateformes cochées :
 *  - offset/simultané : un seul champ partagé (`dateTime`), pertinent dès qu'au moins une plateforme
 *    est cochée (c'est le seul horaire que l'utilisateur voit dans ce mode) ;
 *  - custom : un champ par plateforme cochée (`tiktokTime`/`instagramTime`/`youtubeTime`).
 * Un champ grisé (plateforme non ciblée) n'est jamais renvoyé.
 */
export function relevantTimeFields(card: CardTimeFields, timingMode: BulkTimingMode): TimedField[] {
  if (timingMode === "custom") {
    const fields: TimedField[] = [];
    if (card.platforms.tiktok) fields.push({ field: "tiktokTime", value: card.tiktokTime });
    if (card.platforms.instagram) fields.push({ field: "instagramTime", value: card.instagramTime });
    if (card.platforms.youtube) fields.push({ field: "youtubeTime", value: card.youtubeTime ?? "" });
    return fields;
  }
  if (card.platforms.tiktok || card.platforms.instagram || card.platforms.youtube) {
    return [{ field: "dateTime", value: card.dateTime }];
  }
  return [];
}

/**
 * Parmi les champs horaires pertinents d'une carte (relevantTimeFields), ceux qui tombent dans la
 * fenêtre morte 23h-7h du service (isInQuietWindow) — sert au marqueur ambre par carte ET au résumé
 * du lot (P1-3). Un champ syntaxiquement invalide n'est jamais signalé (il sera de toute façon rejeté
 * par validateCard à la soumission).
 */
export function cardQuietWindowFields(
  card: CardTimeFields,
  timingMode: BulkTimingMode,
  timezone: string
): TimedField[] {
  return relevantTimeFields(card, timingMode).filter(({ value }) => {
    const date = localToDate(value, timezone);
    return date !== null && isInQuietWindow(date, timezone);
  });
}
