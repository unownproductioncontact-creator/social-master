import "server-only";
import { appUrl } from "@/lib/app-url";

const AUTHORIZE_URL = "https://www.instagram.com/oauth/authorize";
const CODE_EXCHANGE_URL = "https://api.instagram.com/oauth/access_token";
// Version épinglée : sans /vXX.0, Meta résout vers la version par défaut de l'app (qui évolue et
// finit dépréciée) → dérives silencieuses dans le temps. AUTHORIZE_URL/CODE_EXCHANGE_URL, eux, ne se
// versionnent pas (par conception). À faire évoluer volontairement.
const GRAPH_BASE = "https://graph.instagram.com/v25.0";

// Scopes vérifiés le 07/07/2026 sur developers.facebook.com/docs/instagram-platform
// (variante "Instagram API with Instagram Login" — aucune Page Facebook requise).
export const INSTAGRAM_SCOPES = ["instagram_business_basic", "instagram_business_content_publish"];

function getRedirectUri(): string {
  return `${appUrl()}/api/oauth/instagram/callback`;
}

function getAppCredentials() {
  const clientId = process.env.META_APP_ID;
  const clientSecret = process.env.META_APP_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("META_APP_ID / META_APP_SECRET manquants");
  }
  return { clientId, clientSecret };
}

export function buildInstagramAuthorizeUrl(state: string): string {
  const { clientId } = getAppCredentials();
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", getRedirectUri());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", INSTAGRAM_SCOPES.join(","));
  url.searchParams.set("state", state);
  return url.toString();
}

type ShortLivedTokenResponse = {
  access_token: string;
  user_id: string;
  permissions: string[]; // TOUJOURS normalisé en tableau (Meta le renvoie en CSV : "scope_a,scope_b")
};

/** Échange le code d'autorisation (valide 1h, usage unique) contre un token court (1h). */
export async function exchangeCodeForShortLivedToken(code: string): Promise<ShortLivedTokenResponse> {
  const { clientId, clientSecret } = getAppCredentials();
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "authorization_code",
    redirect_uri: getRedirectUri(),
    code,
  });

  const res = await fetch(CODE_EXCHANGE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Échange du code Instagram échoué (${res.status}): ${text}`);
  }

  const json = await res.json();
  // La réponse peut être `{ data: [{...}] }` ou directement `{...}` selon la doc — on gère les deux formes.
  const payload = Array.isArray(json?.data) ? json.data[0] : json;
  // ⚠️ Meta renvoie `permissions` en CHAÎNE CSV ("instagram_business_basic,..."), pas en tableau. On
  // normalise ici, sinon Prisma rejette `grantedScopes String[]` (« Expected List, provided String »)
  // → l'upsert échoue → le compte ne peut JAMAIS se connecter.
  const rawPerms: unknown = payload?.permissions;
  const permissions = Array.isArray(rawPerms)
    ? (rawPerms as string[])
    : typeof rawPerms === "string"
      ? rawPerms.split(",").map((p) => p.trim()).filter(Boolean)
      : [];
  return {
    access_token: payload.access_token,
    user_id: String(payload.user_id),
    permissions,
  };
}

type LongLivedTokenResponse = {
  access_token: string;
  token_type: string;
  expires_in: number; // secondes, ~60 jours
};

/** Échange un token court contre un token longue durée (60 jours), serveur uniquement. */
export async function exchangeForLongLivedToken(shortLivedToken: string): Promise<LongLivedTokenResponse> {
  const { clientSecret } = getAppCredentials();
  const url = new URL(`${GRAPH_BASE}/access_token`);
  url.searchParams.set("grant_type", "ig_exchange_token");
  url.searchParams.set("client_secret", clientSecret);
  url.searchParams.set("access_token", shortLivedToken);

  const res = await fetch(url.toString());
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Échange long-lived Instagram échoué (${res.status}): ${text}`);
  }
  return res.json();
}

/** Rafraîchit un token longue durée déjà âgé d'au moins 24h. 100% serveur, sans interaction utilisateur. */
export async function refreshLongLivedToken(longLivedToken: string): Promise<LongLivedTokenResponse> {
  const url = new URL(`${GRAPH_BASE}/refresh_access_token`);
  url.searchParams.set("grant_type", "ig_refresh_token");
  url.searchParams.set("access_token", longLivedToken);

  const res = await fetch(url.toString());
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Refresh token Instagram échoué (${res.status}): ${text}`);
  }
  return res.json();
}

export type InstagramProfile = {
  user_id: string;
  username: string;
  name?: string;
  account_type?: "BUSINESS" | "MEDIA_CREATOR" | "PERSONAL";
  profile_picture_url?: string;
};

export async function fetchInstagramProfile(accessToken: string): Promise<InstagramProfile> {
  const url = new URL(`${GRAPH_BASE}/me`);
  url.searchParams.set("fields", "user_id,username,name,account_type,profile_picture_url");
  url.searchParams.set("access_token", accessToken);

  const res = await fetch(url.toString());
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Lecture du profil Instagram échouée (${res.status}): ${text}`);
  }
  // GET /me peut renvoyer `{ data: [{...}] }` (forme documentée) ou un objet plat — même déballage
  // défensif que l'échange de token, sinon profile.user_id/username seraient undefined → upsert rejeté.
  const json = await res.json();
  const payload = Array.isArray(json?.data) ? json.data[0] : json;
  return payload as InstagramProfile;
}

export function mapInstagramAccountType(
  accountType: InstagramProfile["account_type"]
): "BUSINESS" | "CREATOR" | "PERSONAL" {
  if (accountType === "MEDIA_CREATOR") return "CREATOR";
  if (accountType === "BUSINESS") return "BUSINESS";
  return "PERSONAL";
}

// ---------------------------------------------------------------------------
// Publication (container → poll → publish) — voir CLAUDE.md §2 et §4.
// ---------------------------------------------------------------------------

type ContainerStatusCode = "EXPIRED" | "ERROR" | "FINISHED" | "IN_PROGRESS" | "PUBLISHED";

type CreateContainerParams = {
  igUserId: string;
  accessToken: string;
  caption: string;
  mediaType: "REELS" | "IMAGE" | "STORIES";
  mediaUrl: string; // video_url pour REELS/STORIES vidéo, image_url pour IMAGE/STORIES image
  isVideo?: boolean; // requis pour distinguer une Story image d'une Story vidéo
  thumbOffsetMs?: number; // Reel : frame de couverture (thumb_offset, en ms depuis le début de la vidéo)
};

async function graphFetch(path: string, accessToken: string, params: Record<string, string>, method: "GET" | "POST" = "GET") {
  const url = new URL(`${GRAPH_BASE}${path}`);
  if (method === "GET") {
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    url.searchParams.set("access_token", accessToken);
    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`Graph API Instagram échouée (${res.status}): ${await res.text()}`);
    return res.json();
  }
  const body = new URLSearchParams({ ...params, access_token: accessToken });
  const res = await fetch(url.toString(), { method: "POST", body });
  if (!res.ok) throw new Error(`Graph API Instagram échouée (${res.status}): ${await res.text()}`);
  return res.json();
}

/** Crée un container média (étape 1/3 de la publication). Ne publie pas encore. */
export async function createMediaContainer(params: CreateContainerParams): Promise<string> {
  let body: Record<string, string>;
  if (params.mediaType === "REELS") {
    body = { media_type: "REELS", video_url: params.mediaUrl, caption: params.caption };
    // Couverture du Reel : frame à `thumbOffsetMs` ms (choisie dans le composer pour matcher TikTok).
    if (params.thumbOffsetMs != null && params.thumbOffsetMs >= 0) {
      body.thumb_offset = String(Math.round(params.thumbOffsetMs));
    }
  } else if (params.mediaType === "STORIES") {
    // Pas de `caption` sur une Story : l'API Instagram ne rend aucune légende texte sur les Stories
    // (l'envoyer serait silencieusement ignoré, et pourrait être rejeté si Meta durcit la validation).
    body = {
      media_type: "STORIES",
      ...(params.isVideo ? { video_url: params.mediaUrl } : { image_url: params.mediaUrl }),
    };
  } else {
    body = { image_url: params.mediaUrl, caption: params.caption };
  }

  const json = await graphFetch(`/${params.igUserId}/media`, params.accessToken, body, "POST");
  return json.id as string;
}

/** Container enfant d'un carrousel — pas de caption individuelle, `is_carousel_item` obligatoire. */
export async function createCarouselChildContainer(
  igUserId: string,
  accessToken: string,
  mediaUrl: string,
  isVideo: boolean
): Promise<string> {
  const body: Record<string, string> = isVideo
    ? { media_type: "VIDEO", video_url: mediaUrl, is_carousel_item: "true" }
    : { image_url: mediaUrl, is_carousel_item: "true" };

  const json = await graphFetch(`/${igUserId}/media`, accessToken, body, "POST");
  return json.id as string;
}

/** Container parent d'un carrousel, une fois tous les enfants créés (et traités s'ils sont vidéo). */
export async function createCarouselParentContainer(
  igUserId: string,
  accessToken: string,
  childContainerIds: string[],
  caption: string
): Promise<string> {
  const json = await graphFetch(
    `/${igUserId}/media`,
    accessToken,
    { media_type: "CAROUSEL", children: childContainerIds.join(","), caption },
    "POST"
  );
  return json.id as string;
}

export async function getContainerStatus(containerId: string, accessToken: string): Promise<ContainerStatusCode> {
  const json = await graphFetch(`/${containerId}`, accessToken, { fields: "status_code" });
  return json.status_code as ContainerStatusCode;
}

/** Publie un container déjà FINISHED (étape 3/3). Retourne l'ID du média publié. */
export async function publishContainer(igUserId: string, containerId: string, accessToken: string): Promise<string> {
  const json = await graphFetch(`/${igUserId}/media_publish`, accessToken, { creation_id: containerId }, "POST");
  return json.id as string;
}

export async function fetchMediaPermalink(mediaId: string, accessToken: string): Promise<string | null> {
  try {
    const json = await graphFetch(`/${mediaId}`, accessToken, { fields: "permalink" });
    return json.permalink ?? null;
  } catch {
    return null;
  }
}

export async function getContentPublishingLimit(
  igUserId: string,
  accessToken: string
): Promise<{ quotaUsage: number; quotaTotal: number }> {
  const json = await graphFetch(`/${igUserId}/content_publishing_limit`, accessToken, {
    fields: "quota_usage,config",
  });
  const entry = json.data?.[0];
  return {
    quotaUsage: entry?.quota_usage ?? 0,
    // JAMAIS de plancher optimiste (règle CLAUDE.md §6.5) : si `config.quota_total` est absent, on
    // retombe sur la valeur documentée la plus basse (25) plutôt que 100, pour rester conservateur.
    quotaTotal: entry?.config?.quota_total ?? 25,
  };
}

/**
 * Attend qu'un container atteigne FINISHED (5 min max par défaut). Meta recommande explicitement un
 * poll **1×/min pour 5 min au maximum** — d'où l'intervalle par défaut de 30 s (2×/min, très en dessous
 * de la recommandation, mais loin des 12×/min de l'ancien 5 s qui pouvaient déclencher un rate-limit
 * sur un carrousel multi-vidéos).
 *
 * Distingue les issues (finding audit du 09/07) : ERROR = échec de traitement (média non conforme,
 * PERMANENT → rejet, pas de retry) ; EXPIRED = non publié en 24 h (transitoire, recréer a du sens) ;
 * timeout de poll = transitoire. On lève des MARQUEURS distincts pour que classifyInstagramError
 * n'assimile plus un ERROR à un simple « pas prêt » (ce qui provoquait 3 retries inutiles de ~21 min).
 */
async function waitForContainerReady(
  containerId: string,
  accessToken: string,
  pollIntervalMs: number,
  maxWaitMs: number
): Promise<void> {
  const start = Date.now();
  let status: ContainerStatusCode = "IN_PROGRESS";
  while (status === "IN_PROGRESS") {
    if (Date.now() - start > maxWaitMs) {
      throw new Error("ig_container_timeout: délai de traitement Instagram dépassé");
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    status = await getContainerStatus(containerId, accessToken);
  }
  // FINISHED / PUBLISHED → OK (on sort). Sinon on qualifie précisément l'échec.
  if (status === "ERROR") {
    throw new Error("ig_container_error: le conteneur Instagram a échoué (média probablement non conforme)");
  }
  if (status === "EXPIRED") {
    throw new Error("ig_container_expired: conteneur Instagram expiré (>24h)");
  }
}

/** Orchestre le flow complet pour un média unique (Reel, image, ou Story) : container → poll → publish → permalink. */
export async function publishInstagramMedia(
  params: CreateContainerParams,
  pollIntervalMs = 30000,
  maxWaitMs = 5 * 60 * 1000
): Promise<{ platformPostId: string; platformPostUrl: string | null }> {
  const containerId = await createMediaContainer(params);
  await waitForContainerReady(containerId, params.accessToken, pollIntervalMs, maxWaitMs);

  const mediaId = await publishContainer(params.igUserId, containerId, params.accessToken);
  const permalink = await fetchMediaPermalink(mediaId, params.accessToken);

  return { platformPostId: mediaId, platformPostUrl: permalink };
}

/**
 * Orchestre un carrousel (2 à 10 médias) : un container enfant par média (poll si vidéo) → container
 * parent référençant tous les enfants → poll → publish → permalink.
 */
export async function publishInstagramCarousel(
  igUserId: string,
  accessToken: string,
  caption: string,
  items: Array<{ mediaUrl: string; isVideo: boolean }>,
  pollIntervalMs = 30000,
  maxWaitMs = 5 * 60 * 1000
): Promise<{ platformPostId: string; platformPostUrl: string | null }> {
  if (items.length < 2 || items.length > 10) {
    throw new Error("Un carrousel Instagram doit contenir entre 2 et 10 médias (36000-series)");
  }

  const childIds: string[] = [];
  for (const item of items) {
    const childId = await createCarouselChildContainer(igUserId, accessToken, item.mediaUrl, item.isVideo);
    if (item.isVideo) {
      await waitForContainerReady(childId, accessToken, pollIntervalMs, maxWaitMs);
    }
    childIds.push(childId);
  }

  const parentId = await createCarouselParentContainer(igUserId, accessToken, childIds, caption);
  await waitForContainerReady(parentId, accessToken, pollIntervalMs, maxWaitMs);

  const mediaId = await publishContainer(igUserId, parentId, accessToken);
  const permalink = await fetchMediaPermalink(mediaId, accessToken);

  return { platformPostId: mediaId, platformPostUrl: permalink };
}
