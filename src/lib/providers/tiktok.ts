import "server-only";
import { getObjectStream, headObject } from "@/lib/storage";
import { appUrl } from "@/lib/app-url";
import { TikTokPublishFailedError, TikTokStillProcessingError } from "@/lib/errors";

const AUTHORIZE_URL = "https://www.tiktok.com/v2/auth/authorize/";
const TOKEN_URL = "https://open.tiktokapis.com/v2/oauth/token/";
const USER_INFO_URL = "https://open.tiktokapis.com/v2/user/info/";
const CREATOR_INFO_URL = "https://open.tiktokapis.com/v2/post/publish/creator_info/query/";
const INBOX_VIDEO_INIT_URL = "https://open.tiktokapis.com/v2/post/publish/inbox/video/init/";
const STATUS_FETCH_URL = "https://open.tiktokapis.com/v2/post/publish/status/fetch/";
const CONTENT_INIT_URL = "https://open.tiktokapis.com/v2/post/publish/content/init/";

// Scopes vérifiés le 07/07/2026 sur developers.tiktok.com/doc/tiktok-api-scopes.
// video.upload = mode brouillon (inbox), le seul scope de publication disponible tant que
// l'app n'est PAS auditée. On ne demande PAS video.publish (Direct Post) : ce scope n'existe
// dans l'app qu'une fois le toggle "Direct Post" activé, qui exige l'audit TikTok — le demander
// alors qu'il n'est pas configuré côté app ferait échouer l'autorisation OAuth (constaté le 08/07
// sur l'app réelle : seuls user.info.basic + video.upload sont présents, Direct Post OFF).
// Quand l'app sera auditée pour le Direct Post, réajouter "video.publish" ici.
export const TIKTOK_SCOPES = ["user.info.basic", "video.upload"];

function getRedirectUri(): string {
  return `${appUrl()}/api/oauth/tiktok/callback`;
}

function getAppCredentials() {
  const clientKey = process.env.TIKTOK_CLIENT_KEY;
  const clientSecret = process.env.TIKTOK_CLIENT_SECRET;
  if (!clientKey || !clientSecret) {
    throw new Error("TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET manquants");
  }
  return { clientKey, clientSecret };
}

export function buildTikTokAuthorizeUrl(state: string): string {
  const { clientKey } = getAppCredentials();
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_key", clientKey);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", TIKTOK_SCOPES.join(","));
  url.searchParams.set("redirect_uri", getRedirectUri());
  url.searchParams.set("state", state);
  // Toujours afficher la page d'autorisation TikTok (doc Login Kit Web : 1 = toujours, 0 = sautée
  // pour une session déjà autorisée). Sans ça, « Reconnecter » repassait en silence avec le compte
  // ouvert sur tiktok.com, sans le montrer ni laisser en changer (constaté le 30/09/2026).
  url.searchParams.set("disable_auto_auth", "1");
  return url.toString();
}

type TikTokTokenResponse = {
  access_token: string;
  expires_in: number; // secondes, 24h
  refresh_token: string;
  refresh_expires_in: number; // secondes, 365 jours
  open_id: string;
  scope: string; // liste de scopes accordés, séparés par des virgules
  token_type: string;
};

export async function exchangeTikTokCode(code: string): Promise<TikTokTokenResponse> {
  const { clientKey, clientSecret } = getAppCredentials();
  const body = new URLSearchParams({
    client_key: clientKey,
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
    throw new Error(`Échange du code TikTok échoué (${res.status}): ${text}`);
  }
  return res.json();
}

/** Rafraîchit un access token. ATTENTION : le refresh_token retourné peut différer, toujours le restocker. */
export async function refreshTikTokToken(refreshToken: string): Promise<TikTokTokenResponse> {
  const { clientKey, clientSecret } = getAppCredentials();
  const body = new URLSearchParams({
    client_key: clientKey,
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
    throw new Error(`Refresh token TikTok échoué (${res.status}): ${text}`);
  }
  return res.json();
}

export type TikTokUserInfo = {
  open_id: string;
  display_name: string;
  avatar_url: string;
};

export async function fetchTikTokUserInfo(accessToken: string): Promise<TikTokUserInfo> {
  const url = new URL(USER_INFO_URL);
  url.searchParams.set("fields", "open_id,display_name,avatar_url");

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Lecture du profil TikTok échouée (${res.status}): ${text}`);
  }
  const json = await res.json();
  return json.data.user as TikTokUserInfo;
}

export type TikTokCreatorInfo = {
  creator_avatar_url: string;
  creator_username: string;
  creator_nickname: string;
  privacy_level_options: string[];
  comment_disabled: boolean;
  duet_disabled: boolean;
  stitch_disabled: boolean;
  max_video_post_duration_sec: number;
};

/** À appeler avant CHAQUE écran de publication TikTok (obligatoire selon les guidelines officielles). */
export async function fetchTikTokCreatorInfo(accessToken: string): Promise<TikTokCreatorInfo> {
  const res = await fetch(CREATOR_INFO_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`creator_info TikTok échoué (${res.status}): ${text}`);
  }
  const json = await res.json();
  return json.data as TikTokCreatorInfo;
}

// ---------------------------------------------------------------------------
// Publication en mode brouillon (inbox) — FILE_UPLOAD par chunks depuis R2.
// Doc « Media Transfer Guide » (relue le 01/10/2026) : chunks de 5 à 64 MB, sauf le dernier qui absorbe
// le reste (jusqu'à 128 MB) ; total_chunk_count = plancher(video_size / chunk_size) ; une vidéo de plus
// de 64 MB DOIT partir en plusieurs chunks ; 1 à 1000 chunks ; upload_url valide 1 h. Chaque PUT porte
// Content-Type, Content-Length et Content-Range ; réponse 206 = chunk reçu (d'autres attendus),
// 201 = fichier complet, 400 = Content-Length faux.
// ---------------------------------------------------------------------------

// La doc écrit « 64 MB » sans dire s'il s'agit de 64 000 000 ou de 64 × 1024 × 1024 octets (son exemple
// compte en 10 000 000) : on retient la lecture la plus stricte, 64 000 000.
const MAX_CHUNK_BYTES = 64_000_000;

export type TikTokChunkPlan = { chunkSize: number; ranges: Array<{ start: number; end: number }> };

/**
 * Découpage d'une vidéo pour l'upload FILE_UPLOAD, au modèle exact de la doc TikTok :
 * - ≤ 64 Mo : un seul chunk, `chunk_size` = taille du fichier (obligatoire sous 5 Mo) ;
 * - > 64 Mo : AU MOINS 2 chunks — `chunk_size` = min(64 Mo, moitié du fichier) et
 *   `total_chunk_count` = plancher(taille / chunk_size) ; les premiers chunks font exactement
 *   `chunk_size`, le dernier absorbe le reste (toujours < 128 Mo).
 *
 * Historique (ne pas revenir en arrière) : le 09/07/2026, « 64 Mo + reste » annonçait 2 chunks là où
 * plancher() en donnait 1 → `invalid_param` ; le 01/10/2026, un fichier de 106 Mo envoyé en UN seul
 * chunk (chunk_size 64 Mio) → `invalid_param` aussi.
 */
export function planTikTokChunks(totalSize: number): TikTokChunkPlan {
  if (totalSize <= MAX_CHUNK_BYTES) {
    return { chunkSize: totalSize, ranges: [{ start: 0, end: totalSize - 1 }] };
  }

  const chunkSize = Math.min(MAX_CHUNK_BYTES, Math.floor(totalSize / 2));
  const count = Math.floor(totalSize / chunkSize);
  const ranges: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < count - 1; i++) {
    ranges.push({ start: i * chunkSize, end: (i + 1) * chunkSize - 1 });
  }
  // Dernier chunk : du début de son segment jusqu'à la fin du fichier (absorbe le reste).
  ranges.push({ start: (count - 1) * chunkSize, end: totalSize - 1 });
  return { chunkSize, ranges };
}

type InboxInitResponse = { publish_id: string; upload_url: string };

async function initInboxVideoUpload(
  accessToken: string,
  videoSize: number,
  chunkSize: number,
  totalChunkCount: number
): Promise<InboxInitResponse> {
  const res = await fetch(INBOX_VIDEO_INIT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
    },
    body: JSON.stringify({
      source_info: {
        source: "FILE_UPLOAD",
        video_size: videoSize,
        chunk_size: chunkSize,
        total_chunk_count: totalChunkCount,
      },
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Initialisation upload TikTok échouée (${res.status}): ${text}`);
  }
  const json = await res.json();
  if (json.error?.code && json.error.code !== "ok") {
    throw new Error(`Initialisation upload TikTok refusée : ${json.error.code} — ${json.error.message}`);
  }
  return json.data as InboxInitResponse;
}

const TIKTOK_VIDEO_TYPES = new Set(["video/mp4", "video/quicktime", "video/webm"]);

/**
 * Transfère le fichier depuis R2 vers TikTok, chunk par chunk, sans jamais le bufferiser en RAM.
 * `Content-Length` est obligatoire (doc) : sans lui, le corps partait en « chunked » — le 01/10/2026,
 * TikTok a livré un brouillon dont la fin était abîmée. Avec lui, undici refuse d'envoyer un corps d'une
 * autre taille : jamais de vidéo tronquée en silence.
 */
async function uploadVideoToTikTok(
  uploadUrl: string,
  storageKey: string,
  totalSize: number,
  plan: TikTokChunkPlan,
  mimeType: string
): Promise<void> {
  const contentType = TIKTOK_VIDEO_TYPES.has(mimeType) ? mimeType : "video/mp4";

  for (const [index, range] of plan.ranges.entries()) {
    const length = range.end - range.start + 1;
    const object = await getObjectStream(storageKey, `bytes=${range.start}-${range.end}`);
    if (!object.Body) throw new Error("Lecture du fichier R2 impossible pour l'upload TikTok.");
    if (object.ContentLength !== undefined && object.ContentLength !== length) {
      throw new Error(
        `Lecture R2 incomplète pour l'upload TikTok (${object.ContentLength} octets au lieu de ${length}).`
      );
    }

    const res = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(length),
        "Content-Range": `bytes ${range.start}-${range.end}/${totalSize}`,
      },
      // @ts-expect-error -- duplex requis par Node/undici pour un body en streaming, absent des types DOM actuels
      duplex: "half",
      body: object.Body.transformToWebStream(),
    });
    const text = await res.text().catch(() => "");

    if (!res.ok) {
      throw new Error(`Envoi du chunk TikTok échoué (${res.status}): ${text}`);
    }
    // 206 = TikTok attend encore des octets : après le DERNIER chunk, il ne détient donc pas la vidéo
    // complète. On s'arrête là (publish_id non persisté → un retry repart d'un envoi neuf).
    if (index === plan.ranges.length - 1 && res.status === 206) {
      throw new Error(`TikTok n'a pas reçu la vidéo complète (206 après le dernier chunk) : ${text}`);
    }
  }
}

export type TikTokPublishStatus =
  | "PROCESSING_UPLOAD"
  | "PROCESSING_DOWNLOAD"
  | "SEND_TO_USER_INBOX"
  | "PUBLISH_COMPLETE"
  | "FAILED";

export type TikTokPublishState = {
  status: TikTokPublishStatus | null;
  failReason?: string;
  /** Octets reçus par TikTok pour un FILE_UPLOAD (`uploaded_bytes`) — contrôle d'intégrité de l'envoi. */
  uploadedBytes?: number;
};

/** Statut d'un envoi TikTok (doc « Get Post Status »). `status` vaut null si TikTok n'en renvoie aucun. */
export async function fetchTikTokPublishStatus(
  accessToken: string,
  publishId: string,
  signal?: AbortSignal
): Promise<TikTokPublishState> {
  const res = await fetch(STATUS_FETCH_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
    },
    body: JSON.stringify({ publish_id: publishId }),
    signal,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Lecture du statut TikTok échouée (${res.status}): ${text}`);
  }
  const json = await res.json();
  if (json.error?.code && json.error.code !== "ok") {
    throw new Error(`Lecture du statut TikTok refusée : ${json.error.code} — ${json.error.message}`);
  }
  const uploaded = json.data?.uploaded_bytes;
  return {
    status: json.data?.status ?? null,
    failReason: json.data?.fail_reason,
    uploadedBytes: typeof uploaded === "number" && uploaded > 0 ? uploaded : undefined,
  };
}

/**
 * Démarre un brouillon vidéo TikTok (inbox) : init → upload par chunks. Retourne le `publish_id` une
 * fois le fichier ENTIÈREMENT transmis — c'est à partir de là que TikTok peut livrer le brouillon, et
 * donc qu'un renvoi créerait un doublon. Aucune caption possible (saisie dans l'app TikTok).
 * La taille qui fait foi est celle de l'objet R2 (HEAD), pas seulement celle notée en base : annoncer
 * moins d'octets que le fichier n'en contient enverrait une vidéo tronquée.
 */
export async function startTikTokDraftVideo(
  accessToken: string,
  storageKey: string,
  videoSizeBytes: number,
  mimeType = "video/mp4"
): Promise<string> {
  const head = await headObject(storageKey);
  if (head.outcome === "not_found") throw new Error("Vidéo introuvable sur le stockage pour l'upload TikTok.");
  const totalSize = head.outcome === "found" && head.sizeBytes > 0 ? head.sizeBytes : videoSizeBytes;

  const plan = planTikTokChunks(totalSize);
  const { publish_id, upload_url } = await initInboxVideoUpload(accessToken, totalSize, plan.chunkSize, plan.ranges.length);
  await uploadVideoToTikTok(upload_url, storageKey, totalSize, plan, mimeType);
  return publish_id;
}

/**
 * Attend que TikTok ait déposé le brouillon dans la boîte de réception du créateur.
 * - SEND_TO_USER_INBOX / PUBLISH_COMPLETE → résolu.
 * - FAILED → TikTokPublishFailedError (aucun brouillon ne sera livré).
 * - Toujours en traitement après `maxWaitMs` → TikTokStillProcessingError : PAS un échec, TikTok peut
 *   encore livrer (constaté le 30/09/2026 : ~15 min) — l'appelant reprend plus tard le MÊME publish_id.
 * Un statut absent ou inconnu n'est jamais pris pour un succès : on continue d'attendre.
 */
export async function waitForTikTokInbox(
  accessToken: string,
  publishId: string,
  pollIntervalMs = 3000,
  maxWaitMs = 5 * 60 * 1000
): Promise<{ uploadedBytes?: number }> {
  const start = Date.now();
  for (;;) {
    if (Date.now() - start > maxWaitMs) {
      throw new TikTokStillProcessingError(publishId);
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    const { status, failReason, uploadedBytes } = await fetchTikTokPublishStatus(accessToken, publishId);
    if (status === "SEND_TO_USER_INBOX" || status === "PUBLISH_COMPLETE") return { uploadedBytes };
    if (status === "FAILED") {
      throw new TikTokPublishFailedError(failReason ?? "raison inconnue");
    }
  }
}

// ---------------------------------------------------------------------------
// Publication photo (mode brouillon) — endpoint /v2/post/publish/content/init/.
// ⚠️ Non vérifié empiriquement (nécessite un vrai token) : contrairement au mode brouillon vidéo
// (aucune restriction non-audité documentée sur son endpoint dédié), l'endpoint content/init/ est
// PARTAGÉ entre DIRECT_POST et MEDIA_UPLOAD et son tableau d'erreurs liste bien
// unaudited_client_can_only_post_to_private_accounts — l'exemption "brouillon" pourrait donc ne PAS
// s'appliquer aux photos de la même façon qu'aux vidéos. À tester en priorité une fois l'app créée.
// Par cohérence avec le mode brouillon vidéo (aucun post_info envoyé, tout choisi dans l'app), on
// n'envoie ici que le titre/description pré-remplis, jamais de privacy_level.
// ---------------------------------------------------------------------------

type PhotoInitResponse = { publish_id: string };

async function initPhotoPost(
  accessToken: string,
  photoUrls: string[],
  coverIndex: number,
  title?: string
): Promise<PhotoInitResponse> {
  const res = await fetch(CONTENT_INIT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
    },
    body: JSON.stringify({
      post_mode: "MEDIA_UPLOAD",
      media_type: "PHOTO",
      post_info: title ? { title } : undefined,
      source_info: {
        source: "PULL_FROM_URL",
        photo_images: photoUrls,
        photo_cover_index: coverIndex,
      },
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Initialisation post photo TikTok échouée (${res.status}): ${text}`);
  }
  const json = await res.json();
  if (json.error?.code && json.error.code !== "ok") {
    throw new Error(`Post photo TikTok refusé : ${json.error.code} — ${json.error.message}`);
  }
  return json.data as PhotoInitResponse;
}

/**
 * Démarre un post photo TikTok en brouillon (1 à 35 images, URLs publiques déjà vérifiées auprès de
 * TikTok) et retourne son `publish_id` (TikTok télécharge ensuite les images lui-même).
 */
export async function startTikTokDraftPhoto(accessToken: string, photoUrls: string[]): Promise<string> {
  if (photoUrls.length < 1 || photoUrls.length > 35) {
    throw new Error("Un post photo TikTok doit contenir entre 1 et 35 images.");
  }
  const { publish_id } = await initPhotoPost(accessToken, photoUrls, 0);
  return publish_id;
}
