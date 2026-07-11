import "server-only";
import { getObjectStream } from "@/lib/storage";
import { appUrl } from "@/lib/app-url";
import { YOUTUBE_TITLE_MAX_LENGTH } from "@/lib/content-type";

// Endpoints vérifiés le 11/07/2026 (docs officielles Google, cf. CLAUDE.md §25).
const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CHANNELS_URL = "https://www.googleapis.com/youtube/v3/channels";
const RESUMABLE_UPLOAD_URL = "https://www.googleapis.com/upload/youtube/v3/videos";

const YOUTUBE_DESCRIPTION_MAX = 5000;
// X-Upload-Content-Type / Content-Type du PUT quand le MIME réel du média n'est pas fourni.
const UPLOAD_CONTENT_TYPE_FALLBACK = "video/*";

// Scopes (CLAUDE.md §25) : youtube.upload = publier (videos.insert), youtube.readonly = lire la chaîne
// (channels.list mine=true, pour le nom/avatar affichés et le health-check « Vérifier »). Google veut
// les scopes SÉPARÉS PAR DES ESPACES dans le paramètre `scope` (≠ TikTok/Instagram qui utilisent des virgules).
export const YOUTUBE_SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
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
        // V1 : publication directe et publique à l'heure H (pg-boss), comme IG/TikTok — pas de
        // status.publishAt natif (déféré V2). selfDeclaredMadeForKids explicitement à false (requis).
        privacyStatus: "public",
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

/**
 * Orchestre la publication complète : init resumable → upload streamé → id de la vidéo. Retourne l'id
 * et l'URL publique du Short. Le refresh du token (access ~1h) est fait PAR L'APPELANT juste avant.
 */
export async function publishYouTubeShort(
  params: PublishYouTubeShortParams
): Promise<{ platformPostId: string; platformPostUrl: string }> {
  const sessionUrl = await initResumableUpload(params);
  const { id } = await uploadVideoBinary(sessionUrl, params);
  return {
    platformPostId: id,
    platformPostUrl: `https://www.youtube.com/shorts/${id}`,
  };
}
