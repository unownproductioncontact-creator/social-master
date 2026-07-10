// Mémoire de saisie CÔTÉ CLIENT (P2-5b de l'audit ~/Audit-SocialMaster-2026-07-10.md : « aucune
// mémoire des hashtags/horaires, tout est resaisi chaque jour »). Petit module localStorage PUR et
// client-safe, dans le même esprit que schedule-window.ts/tiktok-window.ts/bulk-ui.ts : aucun import
// serveur/db, aucune directive "use client" nécessaire ici (seuls des composants client l'importent).
//
// Volontairement PAS une source de vérité serveur : simple confort perso mono-utilisateur (usage
// décrit dans CLAUDE.md §1). Toute opération est enveloppée dans un try/catch SILENCIEUX :
// localStorage.getItem/setItem peut lever en mode privé strict (Safari/Firefox, quota à 0, accès
// refusé) et `localStorage` lui-même n'existe pas pendant le rendu SERVEUR d'un Client Component — dans
// les deux cas, ce module se dégrade en no-op plutôt que de casser le composer/bulk.
//
// Clé versionnée : bump `STORAGE_KEY` (« -v2 », …) si le format change un jour, comme
// BULK_DRAFT_STORAGE_KEY dans bulk-composer.tsx.
//
// ⚠️ Ne JAMAIS appeler getLastUsed() pendant le rendu INITIAL d'un Client Component (ex. un
// useState(() => getLastUsed()) évalué au premier rendu) : le serveur n'a pas de localStorage, donc le
// premier rendu client (hydratation) doit matcher exactement le HTML serveur. Lire la mémoire doit se
// faire dans un useEffect APRÈS montage — voir post-composer-form.tsx / bulk-composer.tsx.

const STORAGE_KEY = "sm-last-used-v1";

/** Heure murale stricte « HH:mm » (24h), telle que produite par un <input type="datetime-local">. */
const SCHEDULE_HOUR_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export type LastUsed = {
  hashtags?: string;
  scheduleHour?: string;
};

function readRaw(): LastUsed {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const obj = parsed as Record<string, unknown>;
    const result: LastUsed = {};
    if (typeof obj.hashtags === "string" && obj.hashtags.trim() !== "") {
      result.hashtags = obj.hashtags;
    }
    if (typeof obj.scheduleHour === "string" && SCHEDULE_HOUR_RE.test(obj.scheduleHour)) {
      result.scheduleHour = obj.scheduleHour;
    }
    return result;
  } catch {
    return {};
  }
}

function writeRaw(value: LastUsed): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Mode privé strict / quota dépassé : simple confort perdu, jamais bloquant pour l'utilisateur.
  }
}

/** Dernières valeurs mémorisées, ou `null` s'il n'y a encore rien (ou si localStorage est indisponible). */
export function getLastUsed(): LastUsed | null {
  const value = readRaw();
  return value.hashtags || value.scheduleHour ? value : null;
}

/** Mémorise le texte de hashtags saisi (trim ; une chaîne vide/blanche est ignorée — jamais écraser par du vide). */
export function rememberHashtags(text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  writeRaw({ ...readRaw(), hashtags: trimmed });
}

/** Mémorise une heure de programmation « HH:mm » (ignorée silencieusement si le format ne correspond pas). */
export function rememberScheduleHour(hhmm: string): void {
  if (!SCHEDULE_HOUR_RE.test(hhmm)) return;
  writeRaw({ ...readRaw(), scheduleHour: hhmm });
}

/**
 * Aperçu tronqué d'un texte mémorisé, pour l'attribut `title` de la puce « Réutiliser les derniers
 * hashtags » (évite une bulle-info à rallonge sur une longue liste de hashtags). Partagé entre le
 * composer mono-post et le composer en masse — logique d'affichage générique, colocalisée ici pour
 * éviter de la dupliquer dans les deux composants.
 */
export function truncatePreview(text: string, maxLength = 60): string {
  return text.length > maxLength ? `${text.slice(0, maxLength).trimEnd()}…` : text;
}
