// Statistiques Instagram (CLAUDE.md §43) : règles PURES (aucune I/O), partagées par le job de relevé,
// le connecteur Claude et les pages. Doc Meta vérifiée le 26/10/2026 (Instagram API with Instagram Login,
// /{ig-media-id}/insights et /{ig-user-id}/insights).
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";

export const INSIGHTS_SCOPE = "instagram_business_manage_insights";

export const RECONNECT_FOR_STATS_MESSAGE =
  "Statistiques Instagram non autorisées : dans Social Master, Connexions → Instagram → « Reconnecter », en acceptant l'accès aux statistiques (une seule fois).";

/** Précautions de lecture, rappelées par le connecteur avec chaque réponse. */
export const STATS_CAVEATS = [
  "Vues = lectures organiques sur Instagram (hors publicité et hors Facebook) : souvent un peu moins que le chiffre de l'app.",
  "Meta annonce jusqu'à 48 h de retard : un média de moins de 2 jours n'est pas encore jugeable.",
  "Une métrique à null n'a pas été renvoyée par Meta : ce n'est pas un zéro.",
  "Journées du compte = journées Meta, de minuit à minuit heure de Californie (9 h-9 h à Paris).",
  "views, reach, total_interactions et le taux de zapping sont des métriques « en développement » ou estimées chez Meta : elles peuvent être révisées.",
];

/**
 * Droit de lire les statistiques. Liste vide = inconnue (vieux compte) → on tente ; sinon il faut le scope :
 * un scope ajouté n'est pas rétroactif, le user doit « Reconnecter » Instagram une fois.
 */
export function insightsScopeStatus(grantedScopes: readonly string[]): "granted" | "missing" | "unknown" {
  if (grantedScopes.length === 0) return "unknown";
  return grantedScopes.includes(INSIGHTS_SCOPE) ? "granted" : "missing";
}

/** Métriques d'un Reel (lifetime). `reels_skip_rate` = part des vues zappées dans les 3 premières secondes. */
export const REEL_METRICS = [
  "views",
  "reach",
  "likes",
  "comments",
  "shares",
  "saved",
  "total_interactions",
  "ig_reels_avg_watch_time",
  "ig_reels_video_view_total_time",
  "reels_skip_rate",
] as const;

/** Métriques d'une publication du fil (photo, carrousel, vidéo hors Reel) : sans les métriques propres aux Reels. */
export const FEED_METRICS = ["views", "reach", "likes", "comments", "shares", "saved", "total_interactions"] as const;

/** Dernier repli si même les métriques du fil sont refusées (nom renommé chez Meta, type mal deviné…). */
const BASIC_METRICS = ["views", "reach", "likes", "comments"] as const;

/**
 * Listes de métriques à essayer dans l'ordre pour un média : une seule métrique refusée fait échouer TOUTE
 * la requête (code 100, constaté par d'autres intégrateurs, non documenté), d'où les replis. null = média
 * sans statistiques relevées (Stories, publicités).
 */
/** Reel sans le taux de zapping (métrique la plus récente, la plus susceptible d'être refusée). */
const REEL_METRICS_WITHOUT_SKIP = REEL_METRICS.filter((m) => m !== "reels_skip_rate");

export function metricAttemptsFor(mediaProductType: string | null | undefined): readonly (readonly string[])[] | null {
  if (mediaProductType === "REELS") return [REEL_METRICS, REEL_METRICS_WITHOUT_SKIP, FEED_METRICS, BASIC_METRICS];
  if (mediaProductType === "FEED") return [FEED_METRICS, BASIC_METRICS];
  return null;
}

/**
 * Type de publication d'un média listé par /{ig-user-id}/media. D'abord ce que Social Master a publié
 * (`publishedAs` = PostContentType de la cible), puis `media_product_type` (marqué « Facebook Login
 * seulement » dans la référence mais cité par le guide de publication) ; à défaut, une vidéo qui porte
 * `is_shared_to_feed` (champ propre aux Reels) est un Reel, toute autre vidéo/photo/carrousel = fil.
 */
export function classifyListedMedia(
  item: { media_type?: string | null; media_product_type?: string | null; is_shared_to_feed?: boolean | null },
  publishedAs?: string | null
): string | null {
  // Le plus sûr : ce que Social Master a publié lui-même (type de contenu de la cible Instagram).
  if (publishedAs === "REEL") return "REELS";
  if (publishedAs === "IMAGE" || publishedAs === "CAROUSEL") return "FEED";
  if (publishedAs === "STORY") return "STORY";
  if (item.media_product_type) return item.media_product_type;
  if (item.media_type === "VIDEO") return item.is_shared_to_feed !== undefined && item.is_shared_to_feed !== null ? "REELS" : "FEED";
  if (item.media_type === "IMAGE" || item.media_type === "CAROUSEL_ALBUM") return "FEED";
  return null;
}

export type MediaInsights = { values: Record<string, number>; missing: string[] };

/**
 * Réponse de /{media-id}/insights → valeurs par métrique. Meta renvoie un jeu VIDE (pas 0) quand une donnée
 * manque : la métrique part dans `missing` et ne doit jamais être comptée comme un zéro.
 */
export function parseMediaInsights(json: unknown, requested: readonly string[]): MediaInsights {
  const data = (json as { data?: unknown })?.data;
  const values: Record<string, number> = {};
  if (Array.isArray(data)) {
    for (const entry of data as Array<{ name?: unknown; values?: Array<{ value?: unknown }>; total_value?: { value?: unknown } }>) {
      const raw = entry.values?.[0]?.value ?? entry.total_value?.value;
      if (typeof entry.name === "string" && typeof raw === "number" && Number.isFinite(raw)) values[entry.name] = raw;
    }
  }
  return { values, missing: requested.filter((m) => !(m in values)) };
}

const METRIC_COLUMNS = {
  views: { column: "views", int: true },
  reach: { column: "reach", int: true },
  likes: { column: "likes", int: true },
  comments: { column: "comments", int: true },
  shares: { column: "shares", int: true },
  saved: { column: "saved", int: true },
  total_interactions: { column: "totalInteractions", int: true },
  ig_reels_avg_watch_time: { column: "avgWatchTime", int: false },
  ig_reels_video_view_total_time: { column: "totalWatchTime", int: false },
  reels_skip_rate: { column: "skipRate", int: false },
} as const;

/**
 * Colonnes de InstagramMedia à écrire après un relevé : SEULEMENT les métriques renvoyées. Une métrique
 * absente cette fois (jeu vide passager, repli sans elle) garde sa dernière valeur connue — l'absence est
 * notée dans `missingMetrics`, jamais écrite comme un null qui effacerait l'historique.
 */
export function mediaStatsColumns(values: Record<string, number>): Partial<Record<string, number>> {
  const out: Partial<Record<string, number>> = {};
  for (const [metric, value] of Object.entries(values)) {
    const target = METRIC_COLUMNS[metric as keyof typeof METRIC_COLUMNS];
    if (target) out[target.column] = target.int ? Math.round(value) : value;
  }
  return out;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * Cadence de relevé selon l'âge du média : un Reel se joue dans ses premiers jours (courbe fine), ensuite
 * il bouge peu. Moins de 3 j : toutes les 6 h ; moins de 30 j : tous les jours ; moins de 180 j : chaque
 * semaine ; au-delà : chaque mois. Jamais relevé → maintenant.
 */
export function refreshIntervalMs(postedAt: Date, now: Date): number {
  const age = now.getTime() - postedAt.getTime();
  if (age < 3 * DAY) return 6 * HOUR;
  if (age < 30 * DAY) return DAY;
  if (age < 180 * DAY) return 7 * DAY;
  return 30 * DAY;
}

/** Marge pour qu'un passage toutes les 6 h ne rate pas un relevé dû à quelques minutes près. */
const SLACK_MS = 30 * 60_000;

export function statsRefreshDue(media: { postedAt: Date; statsFetchedAt: Date | null }, now: Date): boolean {
  if (!media.statsFetchedAt) return true;
  return now.getTime() - media.statsFetchedAt.getTime() >= refreshIntervalMs(media.postedAt, now) - SLACK_MS;
}

export type InsightsErrorKind = "permission" | "token" | "rate_limited" | "invalid" | "other";

/** Bilan du dernier relevé, gardé dans `SocialAccount.metadata.instagramStats` (affiché et lu par le connecteur). */
export type InstagramStatsState = {
  lastRunAt: string;
  ok: boolean;
  error?: string;
  errorKind?: InsightsErrorKind | "missing_scope";
  /** Champs de liste utilisés à ce passage : « fallback » = sans media_product_type ni caption (refusés). */
  listFields?: "full" | "fallback";
  /** Métriques du compte utilisées à ce passage : « fallback » = vues et portée seulement. */
  accountMetrics?: "full" | "fallback";
  /** Tout l'historique a été listé au moins une fois (sinon le passage suivant reprend la liste complète). */
  historyComplete?: boolean;
  mediaListed?: number;
  mediaUpdated?: number;
  mediaPending?: number;
  daysUpdated?: number;
};

/**
 * Erreur de l'API Graph pendant un relevé. Jamais de pause du compte ici : une statistique illisible ne doit
 * pas bloquer les publications (seul le flux de publication décide d'une reconnexion).
 */
export function classifyInsightsError(err: unknown): { kind: InsightsErrorKind; message: string } {
  const raw = err instanceof Error ? err.message : String(err);
  let code: number | null = null;
  let subcode: number | null = null;
  let transient = false;
  const jsonStart = raw.indexOf('{"error"');
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(raw.slice(jsonStart)) as {
        error?: { code?: unknown; error_subcode?: unknown; is_transient?: unknown };
      };
      if (typeof parsed.error?.code === "number") code = parsed.error.code;
      if (typeof parsed.error?.error_subcode === "number") subcode = parsed.error.error_subcode;
      transient = parsed.error?.is_transient === true;
    } catch {
      const m = raw.match(/"code"\s*:\s*(-?\d+)/);
      if (m) code = Number(m[1]);
      const sub = raw.match(/"error_subcode"\s*:\s*(-?\d+)/);
      if (sub) subcode = Number(sub[1]);
    }
  }
  // Limites d'appels : génériques (4, 17, 32, 613) et propres à Instagram (80002, sous-code 2446079).
  if (code === 4 || code === 17 || code === 32 || code === 613 || code === 80002 || subcode === 2446079) {
    return { kind: "rate_limited", message: "Limite d'appels Instagram atteinte : relevé repris au passage suivant." };
  }
  if (transient) {
    return { kind: "other", message: `Erreur passagère d'Instagram : ${raw.slice(0, 300)}` };
  }
  if (code === 190) {
    return { kind: "token", message: "Connexion Instagram expirée : cliquez sur « Reconnecter » dans Connexions." };
  }
  if (code === 3 || code === 10 || (code !== null && code >= 200 && code <= 299)) {
    return {
      kind: "permission",
      message: "Instagram refuse l'accès aux statistiques : reconnectez Instagram en acceptant les statistiques.",
    };
  }
  if (code === 100) {
    return { kind: "invalid", message: `Instagram a refusé la demande de statistiques : ${raw.slice(0, 300)}` };
  }
  return { kind: "other", message: `Statistiques Instagram illisibles : ${raw.slice(0, 300)}` };
}

/** Légende raccourcie pour l'affichage et le connecteur. */
export function captionExcerpt(caption: string | null | undefined, max = 90): string | null {
  if (!caption) return null;
  const oneLine = caption.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

// ───────────────────────────── Statistiques du compte, jour par jour ─────────────────────────────

/** Métriques du compte demandées par jour (period=day, metric_type=total_value, sans ventilation). */
export const ACCOUNT_DAY_METRICS = ["views", "reach", "accounts_engaged", "total_interactions", "likes", "comments", "shares"] as const;
export const ACCOUNT_DAY_FALLBACK_METRICS = ["views", "reach"] as const;

/**
 * Fuseau des journées de Meta : la doc actuelle ne le dit plus ; l'ancienne référence et tous les exemples
 * officiels finissent les journées à minuit heure du Pacifique (07:00 UTC l'été, 08:00 UTC l'hiver). Une
 * « journée Meta » va donc de 9 h à 9 h heure de Paris (8 h à 8 h quelques semaines par an).
 */
export const META_DAY_TIMEZONE = "America/Los_Angeles";

/** Meta ne conserve les statistiques du compte que 90 jours : 89 journées, pour qu'aucune fenêtre (minuit du
 * Pacifique) ne déborde au-delà de la conservation. */
export const ACCOUNT_LOOKBACK_DAYS = 89;
/** Meta annonce jusqu'à 48 h de retard : les 3 dernières journées sont relues à chaque passage. */
export const ACCOUNT_PROVISIONAL_DAYS = 3;

/** AAAA-MM-JJ décalé de `delta` jours (calendrier pur, sans fuseau). */
export function shiftDay(day: string, delta: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + delta));
  return t.toISOString().slice(0, 10);
}

/**
 * Journées à (re)lire : toutes les journées terminées des 89 derniers jours qui manquent en base, plus les
 * 3 dernières (provisoires). `today` = date du jour dans le fuseau de Meta ; la journée en cours n'est
 * jamais lue (valeur qui grossit encore). Du plus RÉCENT au plus ancien : une erreur sur les vieilles
 * journées ne prive jamais des récentes.
 */
export function accountDaysToFetch(today: string, storedDays: ReadonlySet<string>): string[] {
  const days: string[] = [];
  for (let back = 1; back <= ACCOUNT_LOOKBACK_DAYS; back++) {
    const day = shiftDay(today, -back);
    if (back <= ACCOUNT_PROVISIONAL_DAYS || !storedDays.has(day)) days.push(day);
  }
  return days;
}

/** Date du jour dans le fuseau des journées de Meta. */
export function metaToday(now: Date): string {
  return formatInTimeZone(now, META_DAY_TIMEZONE, "yyyy-MM-dd");
}

/**
 * Fenêtre since/until (secondes Unix) d'une journée Meta : minuit → minuit suivant, heure du Pacifique
 * (changements d'heure compris). Bornes « incluses » selon la doc, sans plus de précision : le découpage
 * est contrôlé sur un vrai relevé en comparant `reach` d'une journée à la série jour par jour (§43).
 */
export function metaDayWindow(day: string): { since: number; until: number } {
  const start = fromZonedTime(`${day}T00:00:00`, META_DAY_TIMEZONE);
  const end = fromZonedTime(`${shiftDay(day, 1)}T00:00:00`, META_DAY_TIMEZONE);
  return { since: Math.floor(start.getTime() / 1000), until: Math.floor(end.getTime() / 1000) };
}

/** Valeurs `total_value` d'une réponse de /{ig-user-id}/insights (métrique absente = pas de clé). */
export function parseAccountTotals(json: unknown): Record<string, number> {
  const data = (json as { data?: unknown })?.data;
  const out: Record<string, number> = {};
  if (Array.isArray(data)) {
    for (const entry of data as Array<{ name?: unknown; total_value?: { value?: unknown } }>) {
      const v = entry.total_value?.value;
      if (typeof entry.name === "string" && typeof v === "number" && Number.isFinite(v)) out[entry.name] = v;
    }
  }
  return out;
}

// ───────────────────────────── Affichage ─────────────────────────────

/**
 * Temps de visionnage en secondes. Unité non documentée par Meta : les intégrateurs la donnent en
 * millisecondes, ce qui reste à confirmer sur un vrai relevé (CLAUDE.md §43).
 */
export function watchTimeSeconds(raw: number | null | undefined): number | null {
  if (raw == null || !Number.isFinite(raw)) return null;
  return Math.round(raw / 100) / 10;
}

/**
 * Taux de zapping en %. Meta parle de « pourcentage » sans préciser l'échelle : elle est choisie UNE fois
 * pour tout le compte (`maxRaw` = plus grande valeur relevée) — une seule valeur > 1 prouve l'échelle 0-100 ;
 * sinon on lit des fractions (0,42 → 42 %). Jamais décidé valeur par valeur (0,8 % ne doit pas devenir 80 %).
 */
export function skipRatePercent(raw: number | null | undefined, maxRaw?: number | null): number | null {
  if (raw == null || !Number.isFinite(raw)) return null;
  const fraction = (maxRaw ?? raw) <= 1;
  return Math.round((fraction ? raw * 100 : raw) * 10) / 10;
}
