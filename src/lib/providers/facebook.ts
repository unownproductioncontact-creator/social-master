import "server-only";
import { appUrl } from "@/lib/app-url";
import { FacebookPublishFailedError, FacebookStillProcessingError } from "@/lib/errors";
import { decideFacebookVideo, type FacebookVideoStatus } from "@/lib/facebook-publish";

/**
 * Page Facebook (CLAUDE.md §40) — connexion « Facebook Login (for Business) » et publication par l'API
 * Graph. Docs vérifiées le 17/10/2026 : Reels Publishing API (developers.facebook.com/docs/video-api/
 * guides/reels-publishing), Facebook Login for Business, rôles d'app. Version épinglée comme Instagram.
 *
 * Jetons : jeton utilisateur court → jeton utilisateur long (60 j) → jetons de Page via /me/accounts. Un
 * jeton de Page obtenu à partir d'un jeton utilisateur long n'expire pas (sauf mot de passe changé,
 * autorisation retirée…) : rien à rafraîchir, la vérification « Vérifier » suffit.
 */

const GRAPH_VERSION = "v25.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;
// Les envois de vidéos classiques passent par l'hôte vidéo de l'API Graph.
const GRAPH_VIDEO_BASE = `https://graph-video.facebook.com/${GRAPH_VERSION}`;
const DIALOG_URL = `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`;
const RUPLOAD_BASE = `https://rupload.facebook.com/video-upload/${GRAPH_VERSION}`;

/** Autorisations exigées par la publication de Reels sur une Page (doc Reels Publishing API). */
export const FACEBOOK_SCOPES = ["pages_show_list", "pages_read_engagement", "pages_manage_posts"];

function getRedirectUri(): string {
  return `${appUrl()}/api/oauth/facebook/callback`;
}

function getAppCredentials() {
  const clientId = process.env.FACEBOOK_APP_ID;
  const clientSecret = process.env.FACEBOOK_APP_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("FACEBOOK_APP_ID / FACEBOOK_APP_SECRET manquants");
  }
  return { clientId, clientSecret };
}

/**
 * Boîte de connexion. App Meta de type Business : « Facebook Login for Business » demande une
 * configuration (`config_id`, créée dans le tableau de bord de l'app) ; sans elle, on retombe sur les
 * autorisations classiques (`scope`), que la doc tolère pour un jeton utilisateur.
 */
export function buildFacebookAuthorizeUrl(state: string): string {
  const { clientId } = getAppCredentials();
  const url = new URL(DIALOG_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", getRedirectUri());
  url.searchParams.set("state", state);
  url.searchParams.set("response_type", "code");
  const configId = process.env.FACEBOOK_LOGIN_CONFIG_ID;
  if (configId) url.searchParams.set("config_id", configId);
  else url.searchParams.set("scope", FACEBOOK_SCOPES.join(","));
  return url.toString();
}

/** GET sur l'API Graph. L'erreur ne reprend que le chemin et la réponse : jamais l'URL (jeton, secret). */
async function graphGet<T>(path: string, params: Record<string, string>, timeoutMs = 20_000): Promise<T> {
  const url = new URL(`${GRAPH_BASE}/${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  if (!res.ok) throw new Error(`Facebook ${path} a échoué (${res.status}): ${text}`);
  return JSON.parse(text) as T;
}

/** POST (formulaire) sur l'API Graph — le jeton voyage dans le corps, pas dans l'URL. */
async function graphPost<T>(path: string, params: Record<string, string>, base = GRAPH_BASE, timeoutMs = 60_000): Promise<T> {
  const res = await fetch(`${base}/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Facebook ${path} a échoué (${res.status}): ${text}`);
  return JSON.parse(text) as T;
}

// ---------------------------------------------------------------------------------------- connexion

export type FacebookTokenResponse = { access_token: string; token_type?: string; expires_in?: number };

/** Code d'autorisation → jeton utilisateur (courte durée). */
export async function exchangeFacebookCode(code: string): Promise<FacebookTokenResponse> {
  const { clientId, clientSecret } = getAppCredentials();
  return graphGet<FacebookTokenResponse>("oauth/access_token", {
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: getRedirectUri(),
    code,
  });
}

/** Jeton utilisateur court → jeton utilisateur long (~60 j), dont dérivent des jetons de Page sans expiration. */
export async function exchangeLongLivedUserToken(shortLivedToken: string): Promise<FacebookTokenResponse> {
  const { clientId, clientSecret } = getAppCredentials();
  return graphGet<FacebookTokenResponse>("oauth/access_token", {
    grant_type: "fb_exchange_token",
    client_id: clientId,
    client_secret: clientSecret,
    fb_exchange_token: shortLivedToken,
  });
}

export type FacebookPage = { id: string; name: string; accessToken: string; tasks: string[]; pictureUrl?: string };

/** Pages que la personne gère, avec leur jeton de Page et ses droits (tasks). */
export async function fetchManagedPages(userToken: string): Promise<FacebookPage[]> {
  const json = await graphGet<{
    data?: Array<{ id?: unknown; name?: unknown; access_token?: unknown; tasks?: unknown; picture?: { data?: { url?: unknown } } }>;
  }>("me/accounts", { fields: "id,name,access_token,tasks,picture{url}", limit: "100", access_token: userToken });
  return (json.data ?? [])
    .filter((p) => typeof p.access_token === "string" && p.id != null)
    .map((p) => ({
      id: String(p.id),
      name: typeof p.name === "string" ? p.name : "Page Facebook",
      accessToken: p.access_token as string,
      tasks: Array.isArray(p.tasks) ? p.tasks.filter((t): t is string => typeof t === "string") : [],
      pictureUrl: typeof p.picture?.data?.url === "string" ? p.picture.data.url : undefined,
    }));
}

/** Droit de publier : tâche CREATE_CONTENT (ou MANAGE). Sans liste de tâches renvoyée, on tente. */
export function canPublishOnPage(page: Pick<FacebookPage, "tasks">): boolean {
  return page.tasks.length === 0 || page.tasks.includes("CREATE_CONTENT") || page.tasks.includes("MANAGE");
}

/** Autorisations réellement accordées (la personne peut en décocher dans la boîte de connexion). */
export async function fetchGrantedPermissions(userToken: string): Promise<string[]> {
  const json = await graphGet<{ data?: Array<{ permission?: unknown; status?: unknown }> }>("me/permissions", {
    access_token: userToken,
  });
  return (json.data ?? [])
    .filter((p) => p.status === "granted" && typeof p.permission === "string")
    .map((p) => p.permission as string);
}

/** Lecture de la Page avec son jeton : sert de vérification (« Vérifier » dans Connexions). */
export async function fetchFacebookPage(pageId: string, pageToken: string): Promise<{ id: string; name: string }> {
  const json = await graphGet<{ id?: unknown; name?: unknown }>(pageId, { fields: "id,name", access_token: pageToken });
  return { id: String(json.id ?? pageId), name: typeof json.name === "string" ? json.name : "" };
}

// ------------------------------------------------------------------------------------ publication

/** Reel 1/3 : réserve la vidéo → video_id. */
export async function startFacebookReel(pageId: string, pageToken: string): Promise<string> {
  const json = await graphPost<{ video_id?: unknown }>(`${pageId}/video_reels`, { upload_phase: "start", access_token: pageToken });
  if (json.video_id == null) throw new Error(`Facebook ${pageId}/video_reels a échoué (200): réponse sans video_id ${JSON.stringify(json)}`);
  return String(json.video_id);
}

/**
 * Reel 2/3 : Facebook télécharge lui-même le fichier à son URL publique (Worker Cloudflare, sortie
 * gratuite) — en-tête `file_url`, URL sans authentification (doc Reels Publishing API).
 */
export async function uploadFacebookReelFromUrl(videoId: string, pageToken: string, fileUrl: string): Promise<void> {
  const res = await fetch(`${RUPLOAD_BASE}/${videoId}`, {
    method: "POST",
    headers: { Authorization: `OAuth ${pageToken}`, file_url: fileUrl },
    signal: AbortSignal.timeout(180_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Facebook rupload ${videoId} a échoué (${res.status}): ${text}`);
  let success = false;
  try {
    success = (JSON.parse(text) as { success?: unknown }).success === true;
  } catch {
    success = false;
  }
  if (!success) throw new Error(`Facebook rupload ${videoId} a échoué (${res.status}): ${text}`);
}

/** Reel 3/3 : publication, avec la légende (hashtags compris). */
export async function finishFacebookReel(pageId: string, pageToken: string, videoId: string, description: string): Promise<void> {
  const json = await graphPost<{ success?: unknown }>(`${pageId}/video_reels`, {
    upload_phase: "finish",
    video_id: videoId,
    video_state: "PUBLISHED",
    description,
    access_token: pageToken,
  });
  if (json.success !== true) throw new Error(`Facebook ${pageId}/video_reels a échoué (200): publication non confirmée ${JSON.stringify(json)}`);
}

/** Vidéo classique (horizontale ou longue) : envoi par URL ET publication en un seul appel → video_id. */
export async function publishFacebookVideoFromUrl(
  pageId: string,
  pageToken: string,
  fileUrl: string,
  description: string
): Promise<string> {
  const json = await graphPost<{ id?: unknown }>(
    `${pageId}/videos`,
    { file_url: fileUrl, description, published: "true", access_token: pageToken },
    GRAPH_VIDEO_BASE,
    120_000
  );
  if (json.id == null) throw new Error(`Facebook ${pageId}/videos a échoué (200): réponse sans id ${JSON.stringify(json)}`);
  return String(json.id);
}

type RawPhase = { status?: unknown; publish_status?: unknown; errors?: Array<{ message?: unknown; code?: unknown }> };

/** Champ `status` d'une vidéo (Reel ou classique). */
export async function fetchFacebookVideoStatus(videoId: string, pageToken: string): Promise<FacebookVideoStatus> {
  const json = await graphGet<{
    status?: { video_status?: unknown; uploading_phase?: RawPhase; processing_phase?: RawPhase; publishing_phase?: RawPhase };
  }>(videoId, { fields: "status", access_token: pageToken });
  const s = json.status ?? {};
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const errors = [s.uploading_phase, s.processing_phase, s.publishing_phase]
    .flatMap((phase) => phase?.errors ?? [])
    .map((e) => (typeof e.message === "string" ? e.message : `code ${String(e.code)}`));
  return {
    videoStatus: str(s.video_status),
    uploading: str(s.uploading_phase?.status),
    processing: str(s.processing_phase?.status),
    publishing: str(s.publishing_phase?.status),
    publishStatus: str(s.publishing_phase?.publish_status),
    errors,
  };
}

/** Un Reel dont la publication a déjà été demandée (tentative interrompue juste après) ? */
export async function facebookReelPublishRequested(videoId: string, pageToken: string): Promise<boolean> {
  const status = await fetchFacebookVideoStatus(videoId, pageToken);
  return status.publishing !== undefined && status.publishing !== "not_started";
}

/**
 * Attend la mise en ligne d'une vidéo (toutes les 10 s, 4 min au plus dans le job). Délai dépassé →
 * FacebookStillProcessingError (le retry reprend l'attente sans republier) ; statut « error » →
 * FacebookPublishFailedError.
 */
export async function waitForFacebookVideo(
  videoId: string,
  pageToken: string,
  kind: "reel" | "video",
  { intervalMs = 10_000, timeoutMs = 240_000 }: { intervalMs?: number; timeoutMs?: number } = {}
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await fetchFacebookVideoStatus(videoId, pageToken);
    const decision = decideFacebookVideo(status, kind);
    if (decision === "published") return;
    if (decision === "failed") {
      throw new FacebookPublishFailedError(status.errors.join(" ; ") || `statut ${status.videoStatus ?? "inconnu"}`);
    }
    if (Date.now() + intervalMs > deadline) throw new FacebookStillProcessingError(videoId);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** Photo seule, publiée tout de suite → identifiants de la photo et de la publication. */
export async function publishFacebookPhoto(
  pageId: string,
  pageToken: string,
  imageUrl: string,
  caption: string
): Promise<{ photoId: string; postId: string | null }> {
  const json = await graphPost<{ id?: unknown; post_id?: unknown }>(`${pageId}/photos`, {
    url: imageUrl,
    caption,
    published: "true",
    access_token: pageToken,
  });
  if (json.id == null) throw new Error(`Facebook ${pageId}/photos a échoué (200): réponse sans id ${JSON.stringify(json)}`);
  return { photoId: String(json.id), postId: json.post_id != null ? String(json.post_id) : null };
}

/**
 * Plusieurs photos dans une même publication : chaque photo envoyée NON publiée (invisible), puis une
 * seule publication qui les rassemble (`attached_media`) → identifiant de la publication.
 */
export async function publishFacebookPhotos(pageId: string, pageToken: string, imageUrls: string[], caption: string): Promise<string> {
  const photoIds: string[] = [];
  for (const url of imageUrls) {
    const json = await graphPost<{ id?: unknown }>(`${pageId}/photos`, { url, published: "false", access_token: pageToken });
    if (json.id == null) throw new Error(`Facebook ${pageId}/photos a échoué (200): réponse sans id ${JSON.stringify(json)}`);
    photoIds.push(String(json.id));
  }
  const params: Record<string, string> = { message: caption, access_token: pageToken };
  photoIds.forEach((id, i) => {
    params[`attached_media[${i}]`] = JSON.stringify({ media_fbid: id });
  });
  const post = await graphPost<{ id?: unknown }>(`${pageId}/feed`, params);
  if (post.id == null) throw new Error(`Facebook ${pageId}/feed a échoué (200): réponse sans id ${JSON.stringify(post)}`);
  return String(post.id);
}

/** Lien public d'une publication ou d'une vidéo (permalink_url, parfois relatif) ; null si illisible. */
export async function fetchFacebookPermalink(objectId: string, pageToken: string): Promise<string | null> {
  const json = await graphGet<{ permalink_url?: unknown }>(objectId, { fields: "permalink_url", access_token: pageToken });
  const link = typeof json.permalink_url === "string" ? json.permalink_url : null;
  if (!link) return null;
  return link.startsWith("http") ? link : `https://www.facebook.com${link.startsWith("/") ? "" : "/"}${link}`;
}
