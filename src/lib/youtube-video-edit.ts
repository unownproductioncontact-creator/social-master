import { extractGoogleError } from "@/lib/errors";
import { YOUTUBE_TITLE_MAX_LENGTH } from "@/lib/content-type";
import type { YouTubePrivacyStatus } from "@/lib/youtube-options";

/**
 * Modification d'une vidéo DÉJÀ sur YouTube (CLAUDE.md §39, demande du user le 16/10/2026) — module PUR, testé.
 *
 * Doc vérifiée le 16/10/2026 (developers.google.com/youtube/v3/docs/videos/update et /docs/videos) :
 *  - videos.update coûte 50 unités et exige `youtube`, `youtube.force-ssl` ou `youtubepartner` :
 *    `youtube.upload` NE suffit PAS (d'où le scope ajouté et la reconnexion unique) ;
 *  - chaque partie envoyée (snippet, status) REMPLACE toutes ses propriétés modifiables : une propriété
 *    absente est EFFACÉE (description vidée, visibilité remise par défaut…). On relit donc la vidéo et on
 *    renvoie tout ce qu'elle avait, en ne changeant que les champs demandés (lecture-modification-écriture) ;
 *  - snippet : `title` (≤ 100 caractères, ni < ni >) et `categoryId` OBLIGATOIRES ; `description` ≤ 5000
 *    OCTETS (ni < ni >) ; `tags` ≤ 500 caractères au total, virgules comprises, un tag avec espace compte
 *    ses guillemets ;
 *  - status : `publishAt` seulement sur une vidéo privée jamais publiée, avec `privacyStatus: "private"` ;
 *    une date passée publie tout de suite ; `selfDeclaredMadeForKids` et `containsSyntheticMedia` ne
 *    changent que s'ils sont envoyés (on ne les envoie jamais).
 */

/** Scopes qui autorisent videos.update (n'importe lequel suffit). */
export const YOUTUBE_EDIT_SCOPES = [
  "https://www.googleapis.com/auth/youtube.force-ssl",
  "https://www.googleapis.com/auth/youtube",
  "https://www.googleapis.com/auth/youtubepartner",
] as const;

export const YOUTUBE_DESCRIPTION_MAX_BYTES = 5000;
export const YOUTUBE_TAGS_MAX_LENGTH = 500;
/** Une date de publication doit laisser au moins ce délai (en deçà, YouTube publierait aussitôt). */
export const PUBLISH_AT_MIN_LEAD_MS = 60 * 1000;

export const RECONNECT_FOR_EDIT_MESSAGE =
  "La connexion YouTube n'a pas encore le droit de modifier les vidéos : dans Social Master, Connexions → YouTube → « Reconnecter », puis accepter la modification des vidéos (une seule fois).";

/**
 * Droit de modification de la connexion, d'après les scopes enregistrés à la connexion. Liste vide =
 * inconnue (anciens comptes) : on tente, YouTube tranchera.
 */
export function editScopeStatus(grantedScopes: readonly string[]): "granted" | "missing" | "unknown" {
  if (grantedScopes.length === 0) return "unknown";
  return grantedScopes.some((s) => (YOUTUBE_EDIT_SCOPES as readonly string[]).includes(s)) ? "granted" : "missing";
}

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/**
 * Identifiant d'une vidéo à partir de ce que colle l'utilisateur : l'identifiant lui-même ou un lien
 * (watch?v=, youtu.be/, /shorts/, /live/, /embed/, Studio /video/<id>/edit). null si rien de reconnu.
 */
export function parseYouTubeVideoRef(input: string): string | null {
  const raw = input.trim();
  if (VIDEO_ID.test(raw)) return raw;
  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^(www|m|music)\./, "");
  const segments = url.pathname.split("/").filter(Boolean);
  let candidate: string | null | undefined;
  if (host === "youtu.be") {
    candidate = segments[0];
  } else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    candidate =
      segments[0] === "watch"
        ? url.searchParams.get("v")
        : ["shorts", "live", "embed", "v"].includes(segments[0] ?? "")
          ? segments[1]
          : null;
  } else if (host === "studio.youtube.com") {
    candidate = segments[0] === "video" ? segments[1] : null;
  }
  return candidate && VIDEO_ID.test(candidate) ? candidate : null;
}

/** Durée ISO 8601 de YouTube (PT1M5S, P1DT2H…) en secondes ; undefined si illisible. */
export function parseIsoDuration(iso: string | undefined): number | undefined {
  const m = iso?.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return undefined;
  const [, d, h, min, s] = m.map((v) => (v ? Number(v) : 0));
  return d * 86400 + h * 3600 + min * 60 + s;
}

export type YouTubeVideoDetails = {
  id: string;
  channelId: string;
  title: string;
  description: string;
  tags: string[];
  categoryId: string;
  defaultLanguage?: string;
  defaultAudioLanguage?: string;
  /** public | unlisted | private (valeur brute de YouTube). */
  privacyStatus: string;
  /** Date de publication programmée (ISO), tant que la vidéo est privée et programmée. */
  publishAt?: string;
  /** Date de mise en ligne (snippet.publishedAt, ISO). */
  publishedAt?: string;
  uploadStatus?: string;
  embeddable?: boolean;
  license?: string;
  publicStatsViewable?: boolean;
  madeForKids?: boolean;
  durationSec?: number;
};

type RawVideo = {
  id?: unknown;
  snippet?: {
    channelId?: unknown;
    title?: unknown;
    description?: unknown;
    tags?: unknown;
    categoryId?: unknown;
    defaultLanguage?: unknown;
    defaultAudioLanguage?: unknown;
    publishedAt?: unknown;
  };
  status?: {
    privacyStatus?: unknown;
    publishAt?: unknown;
    uploadStatus?: unknown;
    embeddable?: unknown;
    license?: unknown;
    publicStatsViewable?: unknown;
    madeForKids?: unknown;
  };
  contentDetails?: { duration?: unknown };
};

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);

/** Ressource `video` de YouTube (parties snippet, status, contentDetails) → détails utilisés ici. */
export function readVideoDetails(item: unknown): YouTubeVideoDetails | null {
  if (typeof item !== "object" || item === null) return null;
  const v = item as RawVideo;
  const id = str(v.id);
  if (!id) return null;
  const s = v.snippet ?? {};
  const st = v.status ?? {};
  return {
    id,
    channelId: str(s.channelId) ?? "",
    title: str(s.title) ?? "",
    description: str(s.description) ?? "",
    tags: Array.isArray(s.tags) ? s.tags.filter((t): t is string => typeof t === "string") : [],
    categoryId: str(s.categoryId) ?? "",
    defaultLanguage: str(s.defaultLanguage),
    defaultAudioLanguage: str(s.defaultAudioLanguage),
    privacyStatus: str(st.privacyStatus) ?? "",
    publishAt: str(st.publishAt),
    publishedAt: str(s.publishedAt),
    uploadStatus: str(st.uploadStatus),
    embeddable: bool(st.embeddable),
    license: str(st.license),
    publicStatsViewable: bool(st.publicStatsViewable),
    madeForKids: bool(st.madeForKids),
    durationSec: parseIsoDuration(str(v.contentDetails?.duration)),
  };
}

/** Détails après une modification : la réponse de videos.update ne contient que les parties envoyées. */
export function applyUpdateResponse(current: YouTubeVideoDetails, response: unknown): YouTubeVideoDetails {
  const r = (typeof response === "object" && response !== null ? response : {}) as RawVideo;
  const merged = readVideoDetails({
    id: current.id,
    snippet: r.snippet ?? {
      channelId: current.channelId,
      title: current.title,
      description: current.description,
      tags: current.tags,
      categoryId: current.categoryId,
      defaultLanguage: current.defaultLanguage,
      defaultAudioLanguage: current.defaultAudioLanguage,
      publishedAt: current.publishedAt,
    },
    status: r.status ?? {
      privacyStatus: current.privacyStatus,
      publishAt: current.publishAt,
      uploadStatus: current.uploadStatus,
      embeddable: current.embeddable,
      license: current.license,
      publicStatsViewable: current.publicStatsViewable,
      madeForKids: current.madeForKids,
    },
  })!;
  return {
    ...merged,
    // Champs que la réponse peut omettre : on garde ce qu'on savait.
    channelId: merged.channelId || current.channelId,
    publishedAt: merged.publishedAt ?? current.publishedAt,
    uploadStatus: merged.uploadStatus ?? current.uploadStatus,
    madeForKids: merged.madeForKids ?? current.madeForKids,
    durationSec: current.durationSec,
  };
}

/** Longueur d'une chaîne en caractères (points de code, comme YouTube), pas en unités UTF-16. */
function charCount(s: string): number {
  return [...s].length;
}

export function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** Tags nettoyés : sans « # » initial, espaces resserrés, vides retirés, doublons (casse ignorée) retirés. */
export function normalizeTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim().replace(/^#+/, "").replace(/\s+/g, " ").trim();
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    out.push(tag);
  }
  return out;
}

/** Longueur comptée par YouTube : virgules entre tags + guillemets autour d'un tag qui contient un espace. */
export function tagsLength(tags: readonly string[]): number {
  if (tags.length === 0) return 0;
  return tags.reduce((sum, tag) => sum + charCount(tag) + (tag.includes(" ") ? 2 : 0), 0) + (tags.length - 1);
}

export type YouTubeVideoPatch = {
  title?: string;
  description?: string;
  tags?: string[];
  privacy?: YouTubePrivacyStatus;
  publishAt?: Date;
};

/** Champs demandés nettoyés (titre rogné, tags normalisés) : ce qui sera réellement envoyé. */
export function normalizePatch(patch: YouTubeVideoPatch): YouTubeVideoPatch {
  return {
    ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
    ...(patch.description !== undefined ? { description: patch.description.replace(/\r\n/g, "\n").trimEnd() } : {}),
    ...(patch.tags !== undefined ? { tags: normalizeTags(patch.tags) } : {}),
    ...(patch.privacy !== undefined ? { privacy: patch.privacy } : {}),
    ...(patch.publishAt !== undefined ? { publishAt: patch.publishAt } : {}),
  };
}

/**
 * Contrôles AVANT tout appel (message en français, ou null si tout va bien). `current` = la vidéo telle
 * que YouTube la décrit maintenant.
 */
export function validatePatch(patch: YouTubeVideoPatch, current: YouTubeVideoDetails, now: Date): string | null {
  const { title, description, tags, privacy, publishAt } = patch;
  if (title === undefined && description === undefined && tags === undefined && privacy === undefined && publishAt === undefined) {
    return "Rien à modifier : indiquez au moins un champ (titre, description, tags, visibilité ou date de publication).";
  }
  if (title !== undefined) {
    if (!title) return "Le titre ne peut pas être vide.";
    if (charCount(title) > YOUTUBE_TITLE_MAX_LENGTH) {
      return `Titre trop long : ${charCount(title)} caractères pour ${YOUTUBE_TITLE_MAX_LENGTH} au maximum.`;
    }
    if (/[<>]/.test(title)) return "YouTube refuse les caractères < et > dans un titre.";
  }
  if (description !== undefined) {
    const bytes = utf8Bytes(description);
    if (bytes > YOUTUBE_DESCRIPTION_MAX_BYTES) {
      return `Description trop longue : ${bytes} octets pour ${YOUTUBE_DESCRIPTION_MAX_BYTES} au maximum (un emoji ou un accent compte pour plusieurs octets).`;
    }
    if (/[<>]/.test(description)) return "YouTube refuse les caractères < et > dans une description.";
  }
  if (tags !== undefined) {
    if (tags.some((t) => /[<>]/.test(t))) return "YouTube refuse les caractères < et > dans les tags.";
    const length = tagsLength(tags);
    if (length > YOUTUBE_TAGS_MAX_LENGTH) {
      return `Tags trop longs : ${length} caractères comptés par YouTube (virgules et guillemets compris) pour ${YOUTUBE_TAGS_MAX_LENGTH} au maximum.`;
    }
  }
  if (publishAt !== undefined) {
    if (Number.isNaN(publishAt.getTime())) return "Date de publication invalide.";
    if (privacy !== undefined && privacy !== "private") {
      return "Une date de publication programmée rend la vidéo PUBLIQUE à l'heure dite : ne pas la combiner avec une autre visibilité. Pour publier tout de suite, indiquez seulement la visibilité « public ».";
    }
    if (publishAt.getTime() < now.getTime() + PUBLISH_AT_MIN_LEAD_MS) {
      return "La date de publication doit être dans le futur (au moins 1 minute). Pour publier tout de suite, indiquez la visibilité « public ».";
    }
    if (current.privacyStatus !== "private") {
      return "Seule une vidéo privée, jamais publiée, peut être programmée (règle YouTube). Celle-ci est déjà en ligne.";
    }
  }
  return null;
}

export type VideoChange = { field: "title" | "description" | "tags" | "privacy" | "publish_at"; before: string; after: string };

export type VideoUpdatePlan = {
  /** Parties à envoyer à videos.update (vide = rien ne change réellement). */
  parts: Array<"snippet" | "status">;
  body: Record<string, unknown>;
  changes: VideoChange[];
};

function sameInstant(a: string | undefined, b: Date | undefined): boolean {
  if (!a || !b) return !a && !b;
  return Math.abs(Date.parse(a) - b.getTime()) < 60_000;
}

/**
 * Corps de videos.update : la vidéo actuelle + les seuls champs demandés. Une partie n'est envoyée que si
 * l'un de ses champs change vraiment ; elle porte alors TOUTES ses propriétés modifiables (sinon YouTube
 * les effacerait). `patch` doit avoir été normalisé et validé.
 */
export function planVideoUpdate(current: YouTubeVideoDetails, patch: YouTubeVideoPatch): VideoUpdatePlan {
  const changes: VideoChange[] = [];
  const title = patch.title ?? current.title;
  const description = patch.description ?? current.description;
  const tags = patch.tags ?? current.tags;
  if (title !== current.title) changes.push({ field: "title", before: current.title, after: title });
  if (description !== current.description) changes.push({ field: "description", before: current.description, after: description });
  if (tags.join("\u0000") !== current.tags.join("\u0000")) {
    changes.push({ field: "tags", before: current.tags.join(", "), after: tags.join(", ") });
  }
  const snippetChanged = changes.length > 0;

  // Visibilité visée : une date programmée implique « private » (exigé par YouTube).
  const privacy = patch.publishAt ? "private" : (patch.privacy ?? current.privacyStatus);
  const scheduleChanged = patch.publishAt !== undefined && !sameInstant(current.publishAt, patch.publishAt);
  const privacyChanged = privacy !== current.privacyStatus;
  if (privacyChanged) changes.push({ field: "privacy", before: current.privacyStatus, after: privacy });
  if (scheduleChanged) {
    changes.push({ field: "publish_at", before: current.publishAt ?? "", after: patch.publishAt!.toISOString() });
  }
  const statusChanged = privacyChanged || scheduleChanged;

  const body: Record<string, unknown> = { id: current.id };
  const parts: Array<"snippet" | "status"> = [];
  if (snippetChanged) {
    parts.push("snippet");
    body.snippet = {
      title,
      description,
      ...(tags.length > 0 ? { tags } : {}),
      categoryId: current.categoryId,
      ...(current.defaultLanguage ? { defaultLanguage: current.defaultLanguage } : {}),
      ...(current.defaultAudioLanguage ? { defaultAudioLanguage: current.defaultAudioLanguage } : {}),
    };
  }
  if (statusChanged) {
    parts.push("status");
    body.status = {
      privacyStatus: privacy,
      // Une vidéo programmée garde sa date tant qu'elle reste privée (sinon YouTube la déprogrammerait).
      ...(patch.publishAt
        ? { publishAt: patch.publishAt.toISOString() }
        : privacy === "private" && current.publishAt
          ? { publishAt: current.publishAt }
          : {}),
      ...(current.embeddable !== undefined ? { embeddable: current.embeddable } : {}),
      ...(current.license ? { license: current.license } : {}),
      ...(current.publicStatsViewable !== undefined ? { publicStatsViewable: current.publicStatsViewable } : {}),
    };
  }
  return { parts, body, changes };
}

export type ClassifiedEditError = { code: string; message: string; reconnect?: boolean };

const EDIT_QUOTA_REASONS = /quotaExceeded|dailyLimitExceeded|rateLimitExceeded|userRateLimitExceeded/;
const EDIT_CONTENT_MESSAGES: Record<string, string> = {
  invalidTitle: "YouTube refuse ce titre (vide, trop long, ou avec < ou >).",
  invalidDescription: "YouTube refuse cette description (5000 octets au maximum, ni < ni >).",
  invalidTags: "YouTube refuse ces tags (500 caractères au maximum au total).",
  invalidPublishAt:
    "YouTube refuse cette date de publication : seule une vidéo privée jamais publiée peut être programmée, à une date future.",
  invalidCategoryId: "YouTube refuse la catégorie de la vidéo.",
  invalidVideoMetadata: "YouTube refuse ces informations (métadonnées invalides).",
  invalidRecordingDetails: "YouTube refuse les détails d'enregistrement de la vidéo.",
  defaultLanguageNotSet: "YouTube exige une langue par défaut pour cette vidéo.",
  forbiddenPrivacySetting: "YouTube refuse cette visibilité pour cette vidéo.",
  forbiddenLicenseSetting: "YouTube refuse la licence de cette vidéo.",
  forbiddenEmbedSetting: "YouTube refuse le réglage d'intégration de cette vidéo.",
};

/** Erreur de lecture/modification d'une vidéo → code + message clair en français. */
export function classifyVideoEditError(err: unknown): ClassifiedEditError {
  const message = err instanceof Error ? err.message : String(err);
  const { code, reason, oauthError, message: googleMessage } = extractGoogleError(message);

  if ((oauthError && /invalid_grant|invalid_client|unauthorized_client/.test(oauthError)) || /\binvalid_grant\b/.test(message)) {
    return {
      code: "yt_edit_reauth",
      message: "Connexion YouTube expirée ou révoquée : Connexions → YouTube → « Reconnecter ».",
      reconnect: true,
    };
  }
  if (reason === "insufficientPermissions" || /insufficient authentication scopes|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(message)) {
    return { code: "yt_edit_scope", message: RECONNECT_FOR_EDIT_MESSAGE, reconnect: true };
  }
  if (reason && EDIT_QUOTA_REASONS.test(reason)) {
    return {
      code: "yt_edit_quota",
      message: "Quota YouTube du jour atteint (une modification coûte 50 unités) : réessayez après sa remise à zéro, vers 9 h heure de Paris.",
    };
  }
  if (reason && EDIT_CONTENT_MESSAGES[reason]) return { code: "yt_edit_rejected", message: EDIT_CONTENT_MESSAGES[reason] };
  if (code === 404 || reason === "videoNotFound") {
    return { code: "yt_edit_not_found", message: "Vidéo introuvable sur YouTube (supprimée ?)." };
  }
  if (code === 401 || (reason && /authError|unauthorized|invalidCredentials/.test(reason))) {
    return {
      code: "yt_edit_reauth",
      message: "Connexion YouTube refusée : Connexions → YouTube → « Reconnecter ».",
      reconnect: true,
    };
  }
  if (code === 403) {
    return {
      code: "yt_edit_forbidden",
      message: `YouTube refuse la modification de cette vidéo${googleMessage ? ` (« ${googleMessage} »)` : ""}.`,
    };
  }
  if ((code !== null && code >= 500) || /backendError|internalError/.test(message)) {
    return { code: "yt_edit_server", message: "Erreur passagère de YouTube : réessayez dans quelques minutes." };
  }
  if (/fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|aborted|timeout/i.test(message)) {
    return { code: "yt_edit_network", message: "YouTube ne répond pas pour l'instant : réessayez dans quelques minutes." };
  }
  return {
    code: "yt_edit_unknown",
    message: `Modification refusée par YouTube${googleMessage ? ` : « ${googleMessage} »` : code ? ` (HTTP ${code})` : ""}.`,
  };
}
