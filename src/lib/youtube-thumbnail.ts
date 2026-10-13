import { formatInTimeZone } from "date-fns-tz";
import { extractGoogleError } from "@/lib/errors";

/**
 * Miniature personnalisée d'une vidéo YouTube (CLAUDE.md §37) — règles PURES, sans I/O, testées
 * (youtube-thumbnail.test.ts). L'envoi lui-même (`thumbnails.set`) est dans providers/youtube.ts,
 * l'orchestration (statut, nouvel essai, journal) dans youtube-thumbnail-service.ts.
 *
 * Faits vérifiés le 13/10/2026 sur https://developers.google.com/youtube/v3/docs/thumbnails/set :
 * POST …/upload/youtube/v3/thumbnails/set?videoId=…, ~50 unités de quota, scopes youtube.upload /
 * youtube / youtube.force-ssl / youtubepartner, MIME image/jpeg, image/png, application/octet-stream.
 * La page annonce 50 Mo maximum, l'aide YouTube 2 Mo : on s'en tient à 2 Mo (demande du user).
 * Rien dans la doc ne dit que ça marche pour un Short : c'est l'objet du test réel (§37).
 */

/** « 2 Mo » lu au plus strict (comme les 64 Mo de TikTok, §32). */
export const YOUTUBE_THUMBNAIL_MAX_BYTES = 2_000_000;

/** Types envoyés tels quels ; tout autre format est recompressé en JPEG. */
export const YOUTUBE_THUMBNAIL_TYPES: readonly string[] = ["image/jpeg", "image/png"];

/** Qualités JPEG essayées dans l'ordre quand l'image dépasse la limite (dimensions conservées). */
export const THUMBNAIL_JPEG_QUALITIES: readonly number[] = [90, 85, 80, 75, 70, 65, 60, 55, 50, 45, 40];

/** Délai du nouvel essai automatique (un seul) après une erreur 5xx, 429 ou réseau. */
export const THUMBNAIL_RETRY_DELAY_MS = 5 * 60 * 1000;

/** Scopes OAuth qui autorisent `thumbnails.set` (doc officielle). */
export const THUMBNAIL_SCOPES: readonly string[] = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube",
  "https://www.googleapis.com/auth/youtube.force-ssl",
  "https://www.googleapis.com/auth/youtubepartner",
];

export const THUMBNAIL_SCOPE_MESSAGE =
  "L'autorisation YouTube accordée à Social Master ne permet pas de poser une miniature — reconnectez YouTube (Connexions → Reconnecter) en acceptant tous les accès, puis relancez set_youtube_thumbnail.";

/**
 * Le jeton permet-il `thumbnails.set` ? Une liste vide veut dire « inconnue » (Google n'a pas renvoyé
 * les scopes) : on laisse alors YouTube trancher plutôt que de bloquer à tort.
 */
export function canSetThumbnail(grantedScopes: readonly string[]): boolean {
  if (grantedScopes.length === 0) return true;
  return grantedScopes.some((scope) => THUMBNAIL_SCOPES.includes(scope));
}

/** L'image doit-elle être recompressée avant l'envoi ? (format non accepté tel quel, ou trop lourde) */
export function needsThumbnailRecompression(mimeType: string, sizeBytes: number): boolean {
  return !YOUTUBE_THUMBNAIL_TYPES.includes(mimeType) || sizeBytes > YOUTUBE_THUMBNAIL_MAX_BYTES;
}

export type ThumbnailFailure = {
  /** Un nouvel essai automatique a du sens (5xx, 429, réseau, vidéo pas encore visible juste après l'envoi). */
  retryable: boolean;
  code: string;
  /** Message français affiché dans get_post et sur Telegram. */
  message: string;
};

/** Erreur locale (image illisible, trop lourde même recompressée) : jamais retentée. */
export class ThumbnailImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ThumbnailImageError";
  }
}

const RATE_LIMIT_REASONS = /uploadRateLimitExceeded|rateLimitExceeded|userRateLimitExceeded/;
const QUOTA_REASONS = /quotaExceeded|dailyLimitExceeded/;
const AUTH_REASONS = /authError|insufficientPermissions|unauthorized|invalidCredentials/;

/** Erreur réseau côté Render (DNS, coupure, délai dépassé) : la requête n'a pas abouti. */
function isNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    err.name === "AbortError" ||
    err.name === "TimeoutError" ||
    (err.name === "TypeError" && /fetch failed|network/i.test(err.message)) ||
    /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR/.test(err.message)
  );
}

/**
 * Classe une erreur de pose de miniature. Le provider lève `Miniature YouTube refusée (<HTTP>): <corps>` ;
 * le corps Google porte `error.code` (HTTP) et `error.errors[0].reason`. `justUploaded` : la vidéo vient
 * d'être envoyée, un 404 y est plus probablement un délai de propagation qu'une vidéo supprimée.
 */
export function classifyThumbnailError(err: unknown, opts: { justUploaded?: boolean } = {}): ThumbnailFailure {
  if (err instanceof ThumbnailImageError) {
    return { retryable: false, code: "yt_thumb_image", message: err.message };
  }
  if (isNetworkError(err)) {
    return { retryable: true, code: "yt_thumb_network", message: "YouTube injoignable (erreur réseau)." };
  }

  const text = err instanceof Error ? err.message : String(err);
  const google = extractGoogleError(text);
  const httpMatch = text.match(/\((\d{3})\)/);
  const status = google.code ?? (httpMatch ? Number(httpMatch[1]) : null);
  const reason = google.reason ?? "";

  // Jeton : refresh refusé (invalid_grant) ou autorisation insuffisante → reconnexion, pas d'essai.
  if (
    (google.oauthError && /invalid_grant|invalid_client|unauthorized_client|invalid_scope/.test(google.oauthError)) ||
    /\binvalid_grant\b/.test(text) ||
    status === 401 ||
    AUTH_REASONS.test(reason)
  ) {
    return {
      retryable: false,
      code: "yt_thumb_auth",
      message:
        "Connexion YouTube expirée ou autorisation insuffisante — reconnectez YouTube (Connexions → Reconnecter), puis relancez set_youtube_thumbnail.",
    };
  }
  if (QUOTA_REASONS.test(reason)) {
    return {
      retryable: false,
      code: "yt_thumb_quota",
      message: "Quota YouTube du jour atteint — relancez set_youtube_thumbnail demain (remise à zéro à minuit, heure du Pacifique).",
    };
  }
  if (status === 429 || RATE_LIMIT_REASONS.test(reason)) {
    return {
      retryable: true,
      code: "yt_thumb_rate_limited",
      message: "YouTube limite les envois de miniatures sur la chaîne (trop d'envois récents) — réessayez plus tard avec set_youtube_thumbnail.",
    };
  }
  if (status === 403) {
    // La doc liste DEUX refus 403 « forbidden », distingués seulement par leur message.
    if (/doesn.t have permissions to upload and set custom video thumbnails/i.test(google.message ?? text)) {
      return {
        retryable: false,
        code: "yt_thumb_not_allowed",
        message:
          "YouTube refuse (403) : ce compte n'a pas le droit de poser des miniatures personnalisées — chaîne non vérifiée (vérification par téléphone sur youtube.com/verify) ou, pour un Short, fonction pas encore ouverte à la chaîne (réservée au Programme Partenaire YouTube).",
      };
    }
    if (/can.t be set for the specified video/i.test(google.message ?? text)) {
      return {
        retryable: false,
        code: "yt_thumb_forbidden_video",
        message:
          "YouTube refuse la miniature pour CETTE vidéo (403 « The thumbnail can't be set for the specified video ») — pour un Short, YouTube n'accepte peut-être pas (encore) la miniature personnalisée par l'API, ou pas pour cette chaîne.",
      };
    }
    return {
      retryable: false,
      code: "yt_thumb_forbidden",
      message:
        "YouTube refuse la miniature personnalisée (403) : chaîne non éligible — pour un Short, la fonction est réservée aux chaînes du Programme Partenaire YouTube — ou chaîne non vérifiée (vérification par téléphone sur youtube.com/verify).",
    };
  }
  if (status === 400) {
    return {
      retryable: false,
      code: "yt_thumb_invalid_image",
      message: "YouTube refuse l'image (400 : fichier invalide) — envoyez un JPEG ou un PNG valide de moins de 2 Mo.",
    };
  }
  if (status === 404) {
    return opts.justUploaded
      ? { retryable: true, code: "yt_thumb_video_not_ready", message: "YouTube ne trouve pas encore la vidéo qui vient d'être envoyée." }
      : { retryable: false, code: "yt_thumb_video_not_found", message: "Vidéo introuvable sur YouTube (supprimée ou passée sur une autre chaîne ?)." };
  }
  if ((status !== null && status >= 500) || /backendError|internalError/.test(text)) {
    return { retryable: true, code: "yt_thumb_server_error", message: `Erreur serveur YouTube${status ? ` (${status})` : ""}.` };
  }
  return { retryable: true, code: "yt_thumb_unknown", message: "Erreur inattendue pendant l'envoi de la miniature." };
}

/**
 * Réponse brute de YouTube résumée pour l'affichage (get_post) : « 403 forbidden — <message Google> ».
 * Sert au diagnostic ; jamais de jeton dans ces corps d'erreur (Google n'y renvoie que code/raison/texte).
 */
export function summarizeApiError(rawError: string): string | undefined {
  if (!rawError) return undefined;
  const google = extractGoogleError(rawError);
  const httpMatch = rawError.match(/\((\d{3})\)/);
  const status = google.code ?? (httpMatch ? Number(httpMatch[1]) : null);
  if (google.message || google.reason || google.oauthError) {
    const head = [status, google.reason ?? google.oauthError].filter(Boolean).join(" ");
    return google.message ? `${head} — ${google.message}` : head;
  }
  return rawError.slice(0, 300);
}

/** Message tant qu'un nouvel essai est programmé (heure locale de l'utilisateur). */
export function pendingRetryMessage(failure: ThumbnailFailure, retryAt: Date, timezone: string): string {
  return `${failure.message} Nouvel essai automatique vers ${formatInTimeZone(retryAt, timezone, "HH:mm")}.`;
}

/** Message final après l'échec du nouvel essai (ou d'une erreur sans essai possible). */
export function finalFailureMessage(failure: ThumbnailFailure, afterRetry: boolean): string {
  return afterRetry ? `${failure.message} (échec aussi au nouvel essai automatique)` : failure.message;
}

export type ThumbnailUrls = Partial<Record<"default" | "medium" | "high" | "standard" | "maxres", string>>;

const THUMBNAIL_SIZES = ["default", "medium", "high", "standard", "maxres"] as const;

/** Lecture tolérante d'un objet `thumbnails` Google ({ default: { url }, … }) → { default: url, … }. */
export function readThumbnailUrls(raw: unknown): ThumbnailUrls {
  const urls: ThumbnailUrls = {};
  if (typeof raw !== "object" || raw === null) return urls;
  for (const size of THUMBNAIL_SIZES) {
    const entry = (raw as Record<string, unknown>)[size];
    const url = typeof entry === "object" && entry !== null ? (entry as { url?: unknown }).url : undefined;
    if (typeof url === "string" && url) urls[size] = url;
  }
  return urls;
}
