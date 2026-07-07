import "server-only";
import { getObjectStream } from "@/lib/storage";

const AUTHORIZE_URL = "https://www.tiktok.com/v2/auth/authorize/";
const TOKEN_URL = "https://open.tiktokapis.com/v2/oauth/token/";
const USER_INFO_URL = "https://open.tiktokapis.com/v2/user/info/";
const CREATOR_INFO_URL = "https://open.tiktokapis.com/v2/post/publish/creator_info/query/";
const INBOX_VIDEO_INIT_URL = "https://open.tiktokapis.com/v2/post/publish/inbox/video/init/";
const STATUS_FETCH_URL = "https://open.tiktokapis.com/v2/post/publish/status/fetch/";
const CONTENT_INIT_URL = "https://open.tiktokapis.com/v2/post/publish/content/init/";

// Scopes vérifiés le 07/07/2026 sur developers.tiktok.com/doc/tiktok-api-scopes.
// video.upload = mode brouillon (inbox), utilisé tant que l'app n'est pas auditée.
// video.publish demandé dès maintenant pour ne pas re-demander le consentement après l'audit Direct Post.
export const TIKTOK_SCOPES = ["user.info.basic", "video.upload", "video.publish"];

function getRedirectUri(): string {
  return `${process.env.APP_URL}/api/oauth/tiktok/callback`;
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
// Voir CLAUDE.md §2 et §4. Limites vérifiées : chunks 5–64 Mo (dernier jusqu'à 128 Mo),
// 1 à 1000 chunks, upload_url valide 1h.
// ---------------------------------------------------------------------------

const MAX_CHUNK_BYTES = 64 * 1024 * 1024;
const MIN_CHUNK_BYTES = 5 * 1024 * 1024;
const MAX_LAST_CHUNK_BYTES = 128 * 1024 * 1024;

export function computeChunkRanges(totalSize: number): Array<{ start: number; end: number }> {
  if (totalSize <= MAX_CHUNK_BYTES) {
    return [{ start: 0, end: totalSize - 1 }];
  }

  const ranges: Array<{ start: number; end: number }> = [];
  let offset = 0;
  while (totalSize - offset > MAX_CHUNK_BYTES) {
    const remaining = totalSize - offset;
    // Si le morceau restant après ce chunk serait trop petit (< 5 Mo), on l'absorbe
    // dans ce chunk plutôt que de créer un dernier chunk sous la taille minimale.
    if (remaining - MAX_CHUNK_BYTES < MIN_CHUNK_BYTES && remaining <= MAX_LAST_CHUNK_BYTES) {
      ranges.push({ start: offset, end: totalSize - 1 });
      return ranges;
    }
    ranges.push({ start: offset, end: offset + MAX_CHUNK_BYTES - 1 });
    offset += MAX_CHUNK_BYTES;
  }
  ranges.push({ start: offset, end: totalSize - 1 });
  return ranges;
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

/** Transfère le fichier depuis R2 vers TikTok par chunks, sans jamais bufferiser l'intégralité en RAM. */
async function uploadVideoToTikTok(uploadUrl: string, storageKey: string, totalSize: number): Promise<void> {
  const ranges = computeChunkRanges(totalSize);

  for (const range of ranges) {
    const object = await getObjectStream(storageKey, `bytes=${range.start}-${range.end}`);
    if (!object.Body) throw new Error("Lecture du fichier R2 impossible pour l'upload TikTok.");

    const res = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "video/mp4",
        "Content-Range": `bytes ${range.start}-${range.end}/${totalSize}`,
      },
      // @ts-expect-error -- duplex requis par Node/undici pour un body en streaming, absent des types DOM actuels
      duplex: "half",
      body: object.Body.transformToWebStream(),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Envoi du chunk TikTok échoué (${res.status}): ${text}`);
    }
  }
}

type PublishStatus = "PROCESSING_UPLOAD" | "PROCESSING_DOWNLOAD" | "SEND_TO_USER_INBOX" | "PUBLISH_COMPLETE" | "FAILED";

async function fetchPublishStatus(accessToken: string, publishId: string): Promise<{ status: PublishStatus; failReason?: string }> {
  const res = await fetch(STATUS_FETCH_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
    },
    body: JSON.stringify({ publish_id: publishId }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Lecture du statut TikTok échouée (${res.status}): ${text}`);
  }
  const json = await res.json();
  return { status: json.data?.status, failReason: json.data?.fail_reason };
}

/**
 * Orchestre l'envoi d'une vidéo en brouillon TikTok (inbox) : init → upload par chunks → poll
 * jusqu'à SEND_TO_USER_INBOX. Aucune caption possible ici (saisie par l'utilisateur dans l'app TikTok).
 */
export async function publishTikTokDraftVideo(
  accessToken: string,
  storageKey: string,
  videoSizeBytes: number,
  pollIntervalMs = 3000,
  maxWaitMs = 5 * 60 * 1000
): Promise<void> {
  const ranges = computeChunkRanges(videoSizeBytes);
  const chunkSize = ranges.length === 1 ? videoSizeBytes : MAX_CHUNK_BYTES;

  const { publish_id, upload_url } = await initInboxVideoUpload(accessToken, videoSizeBytes, chunkSize, ranges.length);
  await uploadVideoToTikTok(upload_url, storageKey, videoSizeBytes);

  const start = Date.now();
  let status: PublishStatus = "PROCESSING_UPLOAD";
  while (status === "PROCESSING_UPLOAD" || status === "PROCESSING_DOWNLOAD") {
    if (Date.now() - start > maxWaitMs) {
      throw new Error("Délai de traitement TikTok dépassé.");
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    const result = await fetchPublishStatus(accessToken, publish_id);
    status = result.status;
    if (status === "FAILED") {
      throw new Error(`Publication TikTok en échec : ${result.failReason ?? "raison inconnue"}`);
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

/** Envoie un post photo TikTok en brouillon (1 à 35 images, URLs publiques déjà vérifiées auprès de TikTok). */
export async function publishTikTokDraftPhoto(
  accessToken: string,
  photoUrls: string[],
  pollIntervalMs = 3000,
  maxWaitMs = 5 * 60 * 1000
): Promise<void> {
  if (photoUrls.length < 1 || photoUrls.length > 35) {
    throw new Error("Un post photo TikTok doit contenir entre 1 et 35 images.");
  }

  const { publish_id } = await initPhotoPost(accessToken, photoUrls, 0);

  const start = Date.now();
  let status: PublishStatus = "PROCESSING_UPLOAD";
  while (status === "PROCESSING_UPLOAD" || status === "PROCESSING_DOWNLOAD") {
    if (Date.now() - start > maxWaitMs) {
      throw new Error("Délai de traitement TikTok dépassé.");
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    const result = await fetchPublishStatus(accessToken, publish_id);
    status = result.status;
    if (status === "FAILED") {
      throw new Error(`Publication photo TikTok en échec : ${result.failReason ?? "raison inconnue"}`);
    }
  }
}
