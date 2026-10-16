import "server-only";
import { getObjectStream, mediaWorkerPushConfig } from "@/lib/storage";
import { appUrl } from "@/lib/app-url";
import { YOUTUBE_TITLE_MAX_LENGTH } from "@/lib/content-type";
import type { YouTubePrivacyStatus } from "@/lib/youtube-options";
import { readThumbnailUrls, type ThumbnailUrls } from "@/lib/youtube-thumbnail";
import { readVideoDetails, type YouTubeVideoDetails } from "@/lib/youtube-video-edit";

// Endpoints vérifiés le 11/07/2026 (docs officielles Google, cf. CLAUDE.md §25).
const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CHANNELS_URL = "https://www.googleapis.com/youtube/v3/channels";
const RESUMABLE_UPLOAD_URL = "https://www.googleapis.com/upload/youtube/v3/videos";
// Vérifiés le 13/10/2026 (CLAUDE.md §37) : pose de miniature (upload simple) et lecture d'une vidéo.
const THUMBNAIL_SET_URL = "https://www.googleapis.com/upload/youtube/v3/thumbnails/set";
const VIDEOS_URL = "https://www.googleapis.com/youtube/v3/videos";
// Vérifié le 16/10/2026 (CLAUDE.md §39) : vidéos de la chaîne = playlist « uploads » de channels.list.
const PLAYLIST_ITEMS_URL = "https://www.googleapis.com/youtube/v3/playlistItems";

const YOUTUBE_DESCRIPTION_MAX = 5000;
// X-Upload-Content-Type / Content-Type du PUT quand le MIME réel du média n'est pas fourni.
const UPLOAD_CONTENT_TYPE_FALLBACK = "video/*";

// Scopes (CLAUDE.md §25) : youtube.upload = publier (videos.insert), youtube.readonly = lire la chaîne
// (channels.list mine=true, pour le nom/avatar affichés et le health-check « Vérifier »). Google veut
// les scopes SÉPARÉS PAR DES ESPACES dans le paramètre `scope` (≠ TikTok/Instagram qui utilisent des virgules).
// youtube.force-ssl (§39, 16/10/2026) = modifier/supprimer une vidéo existante (videos.update, videos.delete) :
// youtube.upload ne le permet pas. Un compte connecté avant doit être reconnecté une fois.
export const YOUTUBE_SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/youtube.force-ssl",
];

function getRedirectUri(): string {
  return `${appUrl()}/api/oauth/youtube/callback`;
}

function getAppCredentials() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET manquants");
  }
  return { clientId, clientSecret };
}

export function buildYouTubeAuthorizeUrl(state: string): string {
  const { clientId } = getAppCredentials();
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", getRedirectUri());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", YOUTUBE_SCOPES.join(" "));
  // access_type=offline + prompt=consent : garantit la délivrance d'un refresh_token (sans prompt=consent,
  // un utilisateur ayant déjà consenti ne reçoit PAS de refresh_token — cf. CLAUDE.md §25 et le callback).
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("state", state);
  return url.toString();
}

export type GoogleTokenResponse = {
  access_token: string;
  expires_in: number; // secondes (~1h)
  // ABSENT sur un refresh (Google ne fait PAS tourner le refresh token), et absent au 1er échange si
  // l'utilisateur avait déjà consenti SANS prompt=consent — le callback traite ce dernier cas en erreur explicite.
  refresh_token?: string;
  scope: string; // scopes réellement accordés, séparés par des espaces
  token_type: string;
};

/** Échange le code d'autorisation (usage unique) contre les tokens. */
export async function exchangeYouTubeCode(code: string): Promise<GoogleTokenResponse> {
  const { clientId, clientSecret } = getAppCredentials();
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    grant_type: "authorization_code",
    redirect_uri: getRedirectUri(),
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Échange du code YouTube échoué (${res.status}): ${text}`);
  }
  return res.json();
}

/**
 * Rafraîchit un access token. Google NE fait PAS tourner le refresh token (contrairement à TikTok) :
 * la réponse ne contient normalement PAS de `refresh_token`. Si elle en renvoie un néanmoins, l'appelant
 * le restocke par prudence (voir worker/publish-job.ts). Le refresh se fait JUSTE avant chaque publication
 * (access token ~1h) — le cron quotidien ne touche pas aux comptes YouTube en V1 (CLAUDE.md §25).
 */
export async function refreshYouTubeAccessToken(refreshToken: string): Promise<GoogleTokenResponse> {
  const { clientId, clientSecret } = getAppCredentials();
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Refresh token YouTube échoué (${res.status}): ${text}`);
  }
  return res.json();
}

export type YouTubeChannel = {
  id: string;
  title: string;
  thumbnailUrl?: string;
};

/**
 * Récupère la chaîne de l'utilisateur (channels.list part=snippet&mine=true). Utilisé par le callback
 * OAuth (id + titre + avatar à stocker) et par le health-check « Vérifier » côté Connexions.
 */
export async function fetchYouTubeChannel(accessToken: string): Promise<YouTubeChannel> {
  const url = new URL(CHANNELS_URL);
  url.searchParams.set("part", "snippet");
  url.searchParams.set("mine", "true");

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Lecture de la chaîne YouTube échouée (${res.status}): ${text}`);
  }
  const json = await res.json();
  const item = json.items?.[0];
  // Un compte Google sans chaîne YouTube renvoie items=[] (ou une erreur youtubeSignupRequired) : on
  // lève un marqueur classifié en reconnexion (l'utilisateur doit créer une chaîne puis se reconnecter).
  if (!item?.id) {
    throw new Error("youtubeSignupRequired: aucune chaîne YouTube associée à ce compte Google.");
  }
  const thumbnails = item.snippet?.thumbnails ?? {};
  return {
    id: String(item.id),
    title: item.snippet?.title ?? "Chaîne YouTube",
    thumbnailUrl: thumbnails.default?.url ?? thumbnails.medium?.url ?? thumbnails.high?.url,
  };
}

// ---------------------------------------------------------------------------
// Publication d'un Short — videos.insert en upload RESUMABLE, streamé depuis R2 (CLAUDE.md §25).
// Un « Short » est classé AUTOMATIQUEMENT par YouTube (vidéo verticale/carrée ≤ 3 min) : aucun flag API.
// ---------------------------------------------------------------------------

export type PublishYouTubeShortParams = {
  accessToken: string;
  storageKey: string;
  videoSizeBytes: number;
  title: string; // ≤ 100 (tronqué défensivement ci-dessous)
  description: string; // légende + hashtags déjà composés par le worker ; ≤ 5000 (tronqué défensivement)
  contentType?: string; // MIME réel du média (défaut video/*)
  privacyStatus?: YouTubePrivacyStatus; // défaut public ; non répertorié/privé pour un essai (§37)
  /** Programmation native (§38) : vidéo privée que YouTube rend publique à cette date. */
  publishAt?: Date;
};

/**
 * Étape 1/2 — initialise la session d'upload resumable. Renvoie l'URL de session (header `Location`).
 * On y déclare les métadonnées de la vidéo (snippet + status) et la taille/type du binaire à venir.
 */
async function initResumableUpload(params: PublishYouTubeShortParams): Promise<string> {
  const url = new URL(RESUMABLE_UPLOAD_URL);
  url.searchParams.set("uploadType", "resumable");
  url.searchParams.set("part", "snippet,status");

  const res = await fetch(url.toString(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Length": String(params.videoSizeBytes),
      "X-Upload-Content-Type": params.contentType || UPLOAD_CONTENT_TYPE_FALLBACK,
    },
    body: JSON.stringify({
      snippet: {
        // Troncatures DÉFENSIVES : le composer borne déjà côté UI, mais l'API rejette au-delà (400).
        title: params.title.slice(0, YOUTUBE_TITLE_MAX_LENGTH),
        description: params.description.slice(0, YOUTUBE_DESCRIPTION_MAX),
      },
      status: {
        // Publication directe à l'heure H (pg-boss), comme IG/TikTok — pas de status.publishAt natif
        // (déféré V2). Publique par défaut ; non répertoriée/privée si demandé (Short d'essai, §37).
        // selfDeclaredMadeForKids explicitement à false (requis).
        // Programmation native (§38) : publishAt exige privacyStatus « private ».
        privacyStatus: params.publishAt ? "private" : (params.privacyStatus ?? "public"),
        ...(params.publishAt ? { publishAt: params.publishAt.toISOString() } : {}),
        selfDeclaredMadeForKids: false,
      },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Initialisation upload YouTube échouée (${res.status}): ${text}`);
  }
  const location = res.headers.get("location");
  if (!location) {
    throw new Error("Initialisation upload YouTube : header Location manquant dans la réponse.");
  }
  return location;
}

type VideoResource = { id: string };

/**
 * Étape 2/2 — PUT du binaire vidéo streamé depuis R2 vers l'URL de session, en UNE seule requête.
 *
 * Jamais bufferisé en RAM (contrainte 512 Mo Render) : le flux R2 est branché directement sur le corps
 * de la requête (`duplex: "half"` + `transformToWebStream()`), même mécanisme que l'upload TikTok. On
 * envoie tout le fichier d'un coup avec un `Content-Range` couvrant l'intégralité + `Content-Length` —
 * un upload resumable mono-requête. V1 : PAS de découpage multi-chunks (donc pas de reprise 308 Resume
 * Incomplete à gérer) ni de polling de `processingDetails` : la réponse finale porte déjà l'id de la
 * vidéo, ce qui suffit pour construire l'URL du Short (CLAUDE.md §25).
 */
async function uploadVideoBinary(sessionUrl: string, params: PublishYouTubeShortParams): Promise<VideoResource> {
  const object = await getObjectStream(params.storageKey);
  if (!object.Body) throw new Error("Lecture du fichier R2 impossible pour l'upload YouTube.");

  const res = await fetch(sessionUrl, {
    method: "PUT",
    headers: {
      "Content-Type": params.contentType || UPLOAD_CONTENT_TYPE_FALLBACK,
      "Content-Length": String(params.videoSizeBytes),
      "Content-Range": `bytes 0-${params.videoSizeBytes - 1}/${params.videoSizeBytes}`,
    },
    // @ts-expect-error -- duplex requis par Node/undici pour un body en streaming, absent des types DOM actuels
    duplex: "half",
    body: object.Body.transformToWebStream(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Envoi de la vidéo YouTube échoué (${res.status}): ${text}`);
  }
  const json = await res.json();
  if (!json.id) {
    throw new Error(`Réponse YouTube d'upload sans id de vidéo : ${JSON.stringify(json)}`);
  }
  return { id: String(json.id) };
}

function parseVideoResource(status: number, text: string): VideoResource {
  if (status < 200 || status >= 300) {
    throw new Error(`Envoi de la vidéo YouTube échoué (${status}): ${text}`);
  }
  let json: { id?: unknown };
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Réponse YouTube d'upload illisible : ${text.slice(0, 500)}`);
  }
  if (!json.id) throw new Error(`Réponse YouTube d'upload sans id de vidéo : ${text.slice(0, 500)}`);
  return { id: String(json.id) };
}

/**
 * Variante de l'étape 2/2 par le Worker Cloudflare (CLAUDE.md §36) : il lit l'objet dans R2 et le
 * PUT lui-même vers l'URL de session (qui n'exige pas d'en-tête d'autorisation), sa sortie de données
 * est gratuite alors que celle de Render est facturée. Même format d'erreur que l'envoi direct, pour
 * que `classifyYouTubeError` s'applique à l'identique.
 */
async function uploadVideoViaWorker(
  sessionUrl: string,
  params: PublishYouTubeShortParams,
  worker: { url: string; secret: string }
): Promise<VideoResource> {
  const res = await fetch(`${worker.url}/push`, {
    method: "POST",
    headers: { Authorization: `Bearer ${worker.secret}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      key: params.storageKey,
      url: sessionUrl,
      method: "PUT",
      headers: {
        "Content-Type": params.contentType || UPLOAD_CONTENT_TYPE_FALLBACK,
        "Content-Range": `bytes 0-${params.videoSizeBytes - 1}/${params.videoSizeBytes}`,
      },
    }),
  });
  if (!res.ok) {
    throw new Error(`Worker Cloudflare : envoi YouTube impossible (${res.status}): ${await res.text()}`);
  }
  const result = (await res.json()) as { status: number; body: string; bytes: number };
  if (result.bytes !== params.videoSizeBytes) {
    throw new Error(`Taille de la vidéo incohérente (${result.bytes} octets lus dans R2, ${params.videoSizeBytes} attendus).`);
  }
  return parseVideoResource(result.status, result.body);
}

/**
 * Orchestre la publication complète : init resumable → upload streamé → id de la vidéo. Retourne l'id
 * et l'URL publique du Short. Le refresh du token (access ~1h) est fait PAR L'APPELANT juste avant.
 */
export async function publishYouTubeShort(
  params: PublishYouTubeShortParams
): Promise<{ platformPostId: string; platformPostUrl: string }> {
  const sessionUrl = await initResumableUpload(params);
  const worker = mediaWorkerPushConfig();
  const { id } = worker
    ? await uploadVideoViaWorker(sessionUrl, params, worker)
    : await uploadVideoBinary(sessionUrl, params);
  return {
    platformPostId: id,
    platformPostUrl: `https://www.youtube.com/shorts/${id}`,
  };
}

// ---------------------------------------------------------------------------
// Miniature personnalisée (CLAUDE.md §37) — thumbnails.set en upload simple, juste après videos.insert.
// ---------------------------------------------------------------------------

/**
 * Pose (ou remplace) la miniature d'une vidéo. L'image (≤ 2 Mo, déjà préparée par
 * `prepareYouTubeThumbnail`) part dans le corps de la requête. Renvoie les URLs des miniatures que
 * YouTube annonce. Erreur au format `Miniature YouTube refusée (<HTTP>): <corps>` pour
 * `classifyThumbnailError`.
 */
export async function setYouTubeThumbnail(
  accessToken: string,
  videoId: string,
  image: { data: Buffer; contentType: string },
  timeoutMs = 60_000
): Promise<ThumbnailUrls> {
  const url = new URL(THUMBNAIL_SET_URL);
  url.searchParams.set("videoId", videoId);
  url.searchParams.set("uploadType", "media");

  const res = await fetch(url.toString(), {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": image.contentType },
    body: new Uint8Array(image.data),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`Miniature YouTube refusée (${res.status}): ${await res.text()}`);
  }
  const json = (await res.json()) as { items?: unknown[] };
  return readThumbnailUrls(json.items?.[0]);
}

export type YouTubeVideoSummary = {
  privacyStatus?: string;
  uploadStatus?: string;
  /** Date de publication programmée (ISO), tant que la vidéo est privée et programmée. */
  publishAt?: string;
  thumbnails: ThumbnailUrls;
};

/**
 * Lecture d'une vidéo de la chaîne (videos.list part=snippet,status, 1 unité de quota) : miniatures
 * actuellement servies par YouTube et visibilité. `null` si la vidéo n'existe plus.
 */
export async function fetchYouTubeVideoSummary(
  accessToken: string,
  videoId: string,
  signal?: AbortSignal
): Promise<YouTubeVideoSummary | null> {
  const url = new URL(VIDEOS_URL);
  url.searchParams.set("part", "snippet,status");
  url.searchParams.set("id", videoId);

  const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` }, signal });
  if (!res.ok) {
    throw new Error(`Lecture de la vidéo YouTube échouée (${res.status}): ${await res.text()}`);
  }
  const json = (await res.json()) as {
    items?: Array<{
      snippet?: { thumbnails?: unknown };
      status?: { privacyStatus?: string; uploadStatus?: string; publishAt?: string };
    }>;
  };
  const item = json.items?.[0];
  if (!item) return null;
  return {
    privacyStatus: item.status?.privacyStatus,
    uploadStatus: item.status?.uploadStatus,
    publishAt: item.status?.publishAt,
    thumbnails: readThumbnailUrls(item.snippet?.thumbnails),
  };
}

// ---------------------------------------------------------------------------
// Annulation d'une vidéo programmée chez YouTube (CLAUDE.md §38) — jamais sur une vidéo publique :
// l'appelant vérifie d'abord qu'elle est encore privée (videos.list).
// ---------------------------------------------------------------------------

/** Supprime une vidéo (videos.delete, ~50 unités). 204 attendu ; 404 = déjà absente, considéré comme fait. */
export async function deleteYouTubeVideo(accessToken: string, videoId: string): Promise<void> {
  const url = new URL(VIDEOS_URL);
  url.searchParams.set("id", videoId);
  const res = await fetch(url.toString(), {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`Suppression de la vidéo YouTube échouée (${res.status}): ${await res.text()}`);
  }
}

/**
 * Retire la date de publication d'une vidéo programmée : elle reste privée, sans date (videos.update
 * part=status remplace toute la partie status — publishAt absent = programmation retirée). Repli quand
 * la suppression échoue : la vidéo ne sera alors jamais publiée toute seule.
 */
export async function unscheduleYouTubeVideo(accessToken: string, videoId: string): Promise<void> {
  const url = new URL(VIDEOS_URL);
  url.searchParams.set("part", "status");
  const res = await fetch(url.toString(), {
    method: "PUT",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify({ id: videoId, status: { privacyStatus: "private", selfDeclaredMadeForKids: false } }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`Retrait de la programmation YouTube échoué (${res.status}): ${await res.text()}`);
  }
}

// ---------------------------------------------------------------------------
// Modification d'une vidéo déjà sur YouTube (CLAUDE.md §39) — lecture complète, liste des vidéos de la
// chaîne, videos.update. Les règles (lecture-modification-écriture, limites) vivent dans youtube-video-edit.ts.
// ---------------------------------------------------------------------------

/**
 * Lecture complète d'une vidéo (videos.list part=snippet,status,contentDetails, 1 unité) : tout ce qu'il
 * faut renvoyer à videos.update pour ne rien effacer. `null` si YouTube ne la montre pas à ce compte.
 */
export async function fetchYouTubeVideoDetails(
  accessToken: string,
  videoId: string,
  signal?: AbortSignal
): Promise<YouTubeVideoDetails | null> {
  const url = new URL(VIDEOS_URL);
  url.searchParams.set("part", "snippet,status,contentDetails");
  url.searchParams.set("id", videoId);
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: signal ?? AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`Lecture de la vidéo YouTube échouée (${res.status}): ${await res.text()}`);
  }
  const json = (await res.json()) as { items?: unknown[] };
  return readVideoDetails(json.items?.[0]);
}

/**
 * Dernières vidéos de la chaîne connectée, des plus récentes aux plus anciennes (privées et programmées
 * comprises pour le propriétaire) : channels.list → playlist « uploads » → playlistItems.list →
 * videos.list, 3 unités au total.
 */
export async function listYouTubeChannelVideos(accessToken: string, maxResults: number): Promise<YouTubeVideoDetails[]> {
  const headers = { Authorization: `Bearer ${accessToken}` };
  const channelUrl = new URL(CHANNELS_URL);
  channelUrl.searchParams.set("part", "contentDetails");
  channelUrl.searchParams.set("mine", "true");
  const channelRes = await fetch(channelUrl.toString(), { headers, signal: AbortSignal.timeout(15_000) });
  if (!channelRes.ok) {
    throw new Error(`Lecture de la chaîne YouTube échouée (${channelRes.status}): ${await channelRes.text()}`);
  }
  const channel = (await channelRes.json()) as {
    items?: Array<{ contentDetails?: { relatedPlaylists?: { uploads?: string } } }>;
  };
  const uploads = channel.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploads) return [];

  const itemsUrl = new URL(PLAYLIST_ITEMS_URL);
  itemsUrl.searchParams.set("part", "contentDetails");
  itemsUrl.searchParams.set("playlistId", uploads);
  itemsUrl.searchParams.set("maxResults", String(Math.min(Math.max(maxResults, 1), 50)));
  const itemsRes = await fetch(itemsUrl.toString(), { headers, signal: AbortSignal.timeout(15_000) });
  if (!itemsRes.ok) {
    throw new Error(`Liste des vidéos YouTube échouée (${itemsRes.status}): ${await itemsRes.text()}`);
  }
  const items = (await itemsRes.json()) as { items?: Array<{ contentDetails?: { videoId?: string } }> };
  const ids = (items.items ?? []).map((i) => i.contentDetails?.videoId).filter((id): id is string => Boolean(id));
  if (ids.length === 0) return [];

  const videosUrl = new URL(VIDEOS_URL);
  videosUrl.searchParams.set("part", "snippet,status,contentDetails");
  videosUrl.searchParams.set("id", ids.join(","));
  const videosRes = await fetch(videosUrl.toString(), { headers, signal: AbortSignal.timeout(15_000) });
  if (!videosRes.ok) {
    throw new Error(`Lecture des vidéos YouTube échouée (${videosRes.status}): ${await videosRes.text()}`);
  }
  const videos = (await videosRes.json()) as { items?: unknown[] };
  const byId = new Map(
    (videos.items ?? []).map(readVideoDetails).filter((v): v is YouTubeVideoDetails => v !== null).map((v) => [v.id, v])
  );
  // Ordre de la playlist (du plus récent au plus ancien) ; une vidéo supprimée entre-temps disparaît.
  return ids.map((id) => byId.get(id)).filter((v): v is YouTubeVideoDetails => v !== undefined);
}

/**
 * videos.update (50 unités) avec les parties et le corps préparés par `planVideoUpdate`. Renvoie la
 * ressource mise à jour (seulement les parties envoyées). Erreur au format
 * `Modification de la vidéo YouTube refusée (<HTTP>): <corps>` pour `classifyVideoEditError`.
 */
export async function updateYouTubeVideo(
  accessToken: string,
  parts: ReadonlyArray<"snippet" | "status">,
  body: Record<string, unknown>
): Promise<unknown> {
  const url = new URL(VIDEOS_URL);
  url.searchParams.set("part", parts.join(","));
  const res = await fetch(url.toString(), {
    method: "PUT",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    throw new Error(`Modification de la vidéo YouTube refusée (${res.status}): ${await res.text()}`);
  }
  return res.json();
}
