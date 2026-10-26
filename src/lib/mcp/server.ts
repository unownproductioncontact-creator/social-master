import "server-only";
import * as z from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { db } from "@/lib/db";
import {
  publishPostNowForUser,
  reschedulePostForUser,
  saveDraftForUser,
  schedulePostForUser,
  unschedulePostForUser,
} from "@/lib/post-service";
import { collaboratorsFromOptions } from "@/lib/instagram-collaborators";
import { TIKTOK_DRAFT_TIMINGS, tiktokDraftTimingFromOptions } from "@/lib/tiktok-options";
import { TRIAL_STRATEGY_BY_CHOICE, trialChoice, trialFromOptions } from "@/lib/instagram-trial";
import { appUrl } from "@/lib/app-url";
import { buildStorageKey } from "@/lib/storage";
import { resolveShareLink } from "@/lib/media-import/share-link";
import { checkRateLimit } from "@/lib/rate-limit";
import { freshTikTokAccessToken, type TikTokAccountTokens } from "@/lib/tiktok-token";
import { fetchTikTokPublishStatus } from "@/lib/providers/tiktok";
import { tiktokReception } from "@/lib/tiktok-draft";
import { describeDelivery, readDelivery, type DeliveryPath } from "@/lib/delivery-path";
import { fetchYouTubeVideoSummary } from "@/lib/providers/youtube";
import { freshYouTubeAccessToken, type YouTubeAccountTokens } from "@/lib/youtube-token";
import { YOUTUBE_PRIVACY_STATUSES, youtubePrivacyFromOptions } from "@/lib/youtube-options";
import { PROCESSING_NOTE, requestYouTubeThumbnailForUser } from "@/lib/youtube-thumbnail-service";
import { coverTimeFromOptions, readCoverResult, type CoverResult } from "@/lib/instagram-cover";
import { shortsThumbnailApiEnabled, summarizeApiError } from "@/lib/youtube-thumbnail";
import {
  getYouTubeVideoForUser,
  listYouTubeVideosForUser,
  updateYouTubeVideoForUser,
  type EditScope,
} from "@/lib/youtube-video-edit-service";
import { RECONNECT_FOR_EDIT_MESSAGE, tagsLength, utf8Bytes, type VideoChange, type YouTubeVideoDetails } from "@/lib/youtube-video-edit";
import { dbFromPrismaTx, getBoss, MEDIA_IMPORT_QUEUE } from "@/worker/boss";
import {
  getInstagramStatsForTarget,
  getInstagramStatsForUser,
  type InstagramMediaStatsView,
} from "@/lib/instagram-stats-service";
import { requestInstagramStats } from "@/lib/instagram-stats-queue";
import { insightsScopeStatus, RECONNECT_FOR_STATS_MESSAGE, STATS_CAVEATS } from "@/lib/instagram-stats";

/**
 * Serveur MCP du connecteur Claude (CLAUDE.md §29) — un serveur par requête (transport sans état),
 * TOUTES les requêtes scopées par le `userId` du jeton OAuth (règle d'ingénierie n°10). Les actions
 * réutilisent la logique métier du composer (post-service) : mêmes validations, mêmes garde-fous
 * (anti-double publication, quotas TikTok, fenêtre ≥ 60 s…).
 */

function instructions(app: string): string {
  return `Social Master planifie les publications Instagram, TikTok, YouTube Shorts et Page Facebook de l'utilisateur. Adresse de l'app : ${app} (seule adresse valide — ne pas en proposer d'autre).
- Les heures sont TOUJOURS exprimées dans le fuseau de l'utilisateur (indiqué par get_overview), au format « AAAA-MM-JJTHH:mm » en entrée.
- TikTok : la vidéo est déposée en BROUILLON dans la boîte de réception TikTok de l'utilisateur, qui la publie lui-même depuis l'app. Par défaut le brouillon est déposé À L'HEURE PRÉVUE (avec une notification Telegram contenant la légende) ; tiktok_draft_timing = "now" le dépose dès la programmation. Pour un horaire TikTok différent des autres plateformes, faire un post TikTok séparé.
- YouTube programmé (vidéo publique, au moins 15 min à l'avance) : la vidéo est envoyée tout de suite chez YouTube, en privé avec la date de publication ; YouTube la publie lui-même à l'heure prévue, miniature déjà posée.
- Instagram, YouTube et Facebook : publication PUBLIQUE et automatique à l'heure prévue (ou tout de suite avec publish_post_now).
- Facebook (Page) : une vidéo verticale de 3 à 90 s part en Reel, une autre vidéo en vidéo classique ; une photo, ou plusieurs photos (2 à 10) dans une même publication. Même légende et hashtags que les autres plateformes.
- Médias : utiliser ceux de la médiathèque (list_media). Pour un NOUVEAU média, demander à l'utilisateur un lien de partage PUBLIC (Google Drive « Tous les utilisateurs disposant du lien », Dropbox, ou lien direct https) puis appeler import_media_from_url, et suivre l'import avec get_media (quelques secondes à quelques minutes). Une pièce jointe de la conversation ne peut PAS être transmise. Alternative : import manuel sur ${app}/library.
- Miniature d'un Short YouTube : ${shortsThumbnailApiEnabled() ? "une IMAGE de la médiathèque (youtube_thumbnail_media_id dans save_draft), posée par Social Master dès que YouTube a traité la vidéo ; set_youtube_thumbnail pose ou remplace celle d'une vidéo déjà publiée ; état dans get_post (youtube_thumbnail), jamais bloquant pour la vidéo." : "DÉSACTIVÉE — YouTube n'affiche pas (ni sur la chaîne, ni dans la recherche) une miniature de Short envoyée par l'API (vérifié les 13-14/10/2026) ; elle s'ajoute dans YouTube Studio sur ordinateur (Contenus → Shorts → le Short → Miniature → Importer). Ne pas proposer youtube_thumbnail_media_id ni set_youtube_thumbnail pour un Short."} Couverture d'un Reel Instagram : instagram_cover_media_id (image) ou instagram_thumb_offset_ms (image de la vidéo).
- Vidéos déjà sur YouTube (publiées par Social Master ou non, chaîne connectée uniquement) : list_youtube_videos pour les retrouver, get_youtube_video pour lire titre/description/tags actuels, update_youtube_video pour changer titre, description, tags, visibilité ou date de publication d'une vidéo programmée. Le fichier vidéo lui-même ne peut pas être remplacé (YouTube ne le permet pas).
- Statistiques Instagram (vues, portée, likes, commentaires, partages, enregistrements, temps de visionnage, taux de zapping des 3 premières secondes ; vues du compte jour par jour) : get_instagram_stats. Relevées automatiquement toutes les 6 h, pas en direct ; refresh_instagram_stats lance un relevé tout de suite. Vues = lectures organiques sur Instagram seulement (souvent moins que le chiffre de l'app) ; Meta annonce jusqu'à 48 h de retard.
- Avant toute action qui publie, programme ou modifie une vidéo en ligne, résume à l'utilisateur ce qui va changer (plateformes, heure, légende, visibilité YouTube, miniature, réel d'essai éventuel ; pour une modification : avant → après) et attends sa confirmation.`;
}

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: `Erreur : ${message}` }], isError: true };
}

/** Statistiques d'un média Instagram pour le connecteur (null = métrique non renvoyée par Meta, jamais 0). */
function instagramStatsView(v: InstagramMediaStatsView, fmt: (d: Date | null | undefined) => string | null) {
  return {
    media_id: v.mediaId,
    type: v.type === "REELS" ? "reel" : v.type === "FEED" ? "publication" : v.type,
    posted_at: fmt(v.postedAt),
    url: v.permalink ?? undefined,
    caption: v.caption ?? undefined,
    post_id: v.postId ?? undefined,
    views: v.views,
    reach: v.reach,
    likes: v.likes,
    comments: v.comments,
    shares: v.shares,
    saved: v.saved,
    total_interactions: v.totalInteractions,
    ...(v.type === "REELS"
      ? {
          avg_watch_time_s: v.avgWatchSeconds,
          total_watch_time_h: v.totalWatchSeconds == null ? null : Math.round(v.totalWatchSeconds / 360) / 10,
          skip_rate_pct: v.skipRatePct,
        }
      : {}),
    ...(v.missing.length > 0 ? { missing_metrics: v.missing } : {}),
    stats_at: fmt(v.fetchedAt) ?? "pas encore relevé",
    ...(v.error ? { error: v.error } : {}),
    ...(v.history
      ? {
          history: v.history.map((h) => ({ at: fmt(h.fetchedAt), age_hours: h.ageHours, ...h.metrics })),
          history_note: "Valeurs brutes de Meta dans history (ig_reels_avg_watch_time en millisecondes supposées, reels_skip_rate à l'échelle de Meta).",
        }
      : {}),
  };
}

/**
 * Ce que TikTok a réellement reçu pour un envoi (statut + octets reçus vs taille du fichier), lu EN DIRECT
 * — pour vérifier qu'un brouillon est arrivé entier. Jamais bloquant : erreur lisible si TikTok ne répond pas.
 */
async function readTikTokReception(account: TikTokAccountTokens, publishId: string, expectedBytes: number | undefined) {
  try {
    const token = await freshTikTokAccessToken(account);
    const state = await fetchTikTokPublishStatus(token, publishId, AbortSignal.timeout(5000));
    return {
      tiktok_status: state.status,
      ...tiktokReception(state.uploadedBytes, expectedBytes),
      fail_reason: state.failReason,
    };
  } catch (err) {
    return { error: `Statut TikTok illisible pour l'instant : ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Ce que YouTube affiche EN DIRECT pour une vidéo publiée (videos.list, 1 unité de quota) : visibilité,
 * état de l'envoi et URLs des miniatures servies — pour vérifier qu'une miniature personnalisée a pris.
 * Jamais bloquant : erreur lisible si YouTube ne répond pas.
 */
async function readYouTubeLive(account: YouTubeAccountTokens, videoId: string, fmtIso: (iso: string) => string) {
  try {
    const token = await freshYouTubeAccessToken(account);
    const video = await fetchYouTubeVideoSummary(token, videoId, AbortSignal.timeout(5000));
    if (!video) return { error: "Vidéo introuvable sur YouTube (supprimée ?)." };
    return {
      privacy_status: video.privacyStatus,
      upload_status: video.uploadStatus,
      ...(video.publishAt ? { publish_at: fmtIso(video.publishAt) } : {}),
      thumbnails: video.thumbnails,
    };
  } catch (err) {
    return { error: `Lecture YouTube impossible pour l'instant : ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Phrase lisible de la couverture réellement utilisée par un Reel publié. */
function describeCover(result: CoverResult): string {
  if (result.applied === "cover_url") return "image de couverture choisie (cover_url)";
  if (result.reason === "cover_refused") return "couverture refusée par Instagram : image tirée de la vidéo";
  return result.thumbOffsetMs != null ? `image de la vidéo à ${result.thumbOffsetMs} ms (thumb_offset)` : "image de la vidéo";
}

/** Nom lisible d'un média : dernier segment de la clé R2 sans le préfixe UUID (« uuid-nom.mp4 »). */
function mediaName(storageKey: string): string {
  const last = storageKey.split("/").pop() ?? storageKey;
  return last.replace(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i, "");
}

const POST_STATUS = {
  draft: "DRAFT",
  scheduled: "SCHEDULED",
  published: "PUBLISHED",
  partially_published: "PARTIALLY_PUBLISHED",
  failed: "FAILED",
} as const;

const DATETIME_LOCAL = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, { error: "Format attendu : AAAA-MM-JJTHH:mm (heure locale)." })
  .describe("Date et heure LOCALES de l'utilisateur, format AAAA-MM-JJTHH:mm (ex. 2026-10-02T18:30)");

export async function buildMcpServer(userId: string): Promise<McpServer> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { email: true, timezone: true } });
  const tz = user?.timezone ?? "Europe/Paris";
  const fmt = (d: Date | null | undefined) => (d ? formatInTimeZone(d, tz, "yyyy-MM-dd HH:mm") : null);
  const app = appUrl();

  const server = new McpServer({ name: "social-master", version: "1.0.0" }, { instructions: instructions(app) });

  // ------------------------------------------------------------------ lecture

  server.registerTool(
    "get_overview",
    {
      title: "Vue d'ensemble",
      description:
        "Tableau de bord : comptes connectés et leur état, fuseau horaire, compteurs (programmées sous 72 h, publiées sur 30 jours, échecs, brouillons TikTok à finaliser) et prochaines publications.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const now = new Date();
      // Une seule connexion (transaction groupée, lectures séquentielles) plutôt que 7 en parallèle :
      // ménage le petit pool Postgres (Supabase free / moteur local) — CLAUDE.md §29.
      const [accounts, upcoming, scheduled72h, published30d, failedTargets, tiktokToFinalize, drafts] = await db.$transaction([
        db.socialAccount.findMany({ where: { userId }, select: { platform: true, username: true, status: true, tokenExpiresAt: true } }),
        db.post.findMany({
          where: { userId, status: "SCHEDULED", scheduledAt: { gte: now } },
          orderBy: { scheduledAt: "asc" },
          take: 5,
          include: { postTargets: { select: { platform: true } } },
        }),
        db.post.count({ where: { userId, status: "SCHEDULED", scheduledAt: { gte: now, lte: new Date(now.getTime() + 72 * 3600 * 1000) } } }),
        db.postTarget.count({ where: { post: { userId }, status: { in: ["PUBLISHED", "SENT_TO_INBOX"] }, publishedAt: { gte: new Date(now.getTime() - 30 * 24 * 3600 * 1000) } } }),
        db.postTarget.count({ where: { post: { userId }, status: "FAILED" } }),
        db.postTarget.count({ where: { post: { userId }, platform: "TIKTOK", status: "SENT_TO_INBOX", publishedAt: { gte: new Date(now.getTime() - 7 * 24 * 3600 * 1000) } } }),
        db.post.count({ where: { userId, status: "DRAFT" } }),
      ]);
      return ok({
        user: user?.email,
        app_url: app,
        library_url: `${app}/library`,
        timezone: tz,
        now: fmt(now),
        accounts: accounts.map((a) => ({
          platform: a.platform,
          username: a.username,
          status: a.status,
          token_expires_at: a.platform === "INSTAGRAM" ? fmt(a.tokenExpiresAt) : undefined,
        })),
        counts: {
          scheduled_next_72h: scheduled72h,
          published_last_30d: published30d,
          failed_targets: failedTargets,
          tiktok_drafts_last_7d: tiktokToFinalize,
          drafts,
        },
        upcoming: upcoming.map((p) => ({
          post_id: p.id,
          scheduled_at: fmt(p.scheduledAt),
          platforms: p.postTargets.map((t) => t.platform),
          caption: p.caption.slice(0, 120),
        })),
      });
    }
  );

  server.registerTool(
    "list_media",
    {
      title: "Lister la médiathèque",
      description:
        "Médias disponibles (du plus récent au plus ancien) avec leur identifiant, à utiliser dans save_draft (media_ids). Pour en ajouter : page Médiathèque de l'app (library_url de get_overview).",
      inputSchema: {
        kind: z.enum(["all", "video", "image"]).default("all").describe("Filtrer par type de média"),
        limit: z.number().int().min(1).max(100).default(30),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ kind, limit }) => {
      const media = await db.mediaAsset.findMany({
        where: {
          userId,
          status: "READY",
          ...(kind === "video" ? { mimeType: { startsWith: "video/" } } : kind === "image" ? { mimeType: { startsWith: "image/" } } : {}),
        },
        orderBy: { createdAt: "desc" },
        take: limit,
        include: { _count: { select: { postMedia: true, coverForTargets: true } } },
      });
      return ok(
        media.map((m) => ({
          media_id: m.id,
          name: mediaName(m.storageKey),
          kind: m.mimeType.startsWith("video/") ? "video" : "image",
          size_mb: Math.round((m.sizeBytes / (1024 * 1024)) * 10) / 10,
          duration_s: m.durationSec ?? undefined,
          width: m.width ?? undefined,
          height: m.height ?? undefined,
          added_at: fmt(m.createdAt),
          used_in_posts: m._count.postMedia,
          used_as_thumbnail: m._count.coverForTargets || undefined,
        }))
      );
    }
  );

  server.registerTool(
    "list_posts",
    {
      title: "Lister les publications",
      description: "Publications (les plus récemment modifiées d'abord) avec leur statut par plateforme, erreurs et liens.",
      inputSchema: {
        status: z
          .enum(["all", "draft", "scheduled", "published", "partially_published", "failed"])
          .default("all")
          .describe("Filtrer par statut du post"),
        limit: z.number().int().min(1).max(50).default(20),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ status, limit }) => {
      const posts = await db.post.findMany({
        where: { userId, ...(status !== "all" ? { status: POST_STATUS[status] } : {}) },
        orderBy: { updatedAt: "desc" },
        take: limit,
        include: { postTargets: true },
      });
      return ok(
        posts.map((p) => ({
          post_id: p.id,
          status: p.status,
          scheduled_at: fmt(p.scheduledAt),
          caption: p.caption.slice(0, 120),
          targets: p.postTargets.map((t) => ({
            platform: t.platform,
            content_type: t.contentType,
            status: t.status,
            published_at: fmt(t.publishedAt),
            url: t.platformPostUrl ?? undefined,
            error: t.errorMessage ?? undefined,
          })),
        }))
      );
    }
  );

  server.registerTool(
    "get_post",
    {
      title: "Détail d'une publication",
      description:
        "Tout le détail d'un post : légende, hashtags, médias, cibles par plateforme (options, statut, erreur, lien). Pour un envoi TikTok : tiktok_reception = ce que TikTok a réellement reçu (received_bytes doit égaler expected_bytes). Pour une cible publiée : delivered_via = « worker » (Worker Cloudflare, sortie gratuite) ou « render » (sortie facturée au-delà de 5 Go/mois), absent pour les publications faites avant la mise en place de ce suivi. Cible YouTube : youtube_visibility, youtube_thumbnail = { media_id, status PENDING | SET | FAILED, error, set_at } (statut SÉPARÉ de la vidéo) et, une fois publiée, youtube_live = ce que YouTube affiche en direct (visibilité, URLs des miniatures servies). Cible Instagram (Reel) : instagram_cover = image de couverture choisie et ce qui a réellement été utilisé ; une fois publiée, instagram_stats = dernières statistiques relevées (voir get_instagram_stats).",
      inputSchema: { post_id: z.string().min(1) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ post_id }) => {
      const post = await db.post.findFirst({
        where: { id: post_id, userId },
        include: {
          postMedia: { include: { mediaAsset: true }, orderBy: { position: "asc" } },
          postTargets: { include: { socialAccount: true, coverMedia: true } },
        },
      });
      if (!post) return fail("Post introuvable.");
      const video = post.postMedia.find((pm) => pm.mediaAsset.mimeType.startsWith("video/"))?.mediaAsset;
      const receptions = new Map(
        await Promise.all(
          post.postTargets
            .filter((t) => t.platform === "TIKTOK" && t.tiktokPublishId)
            .map(async (t) => [
              t.id,
              await readTikTokReception(
                t.socialAccount,
                t.tiktokPublishId!,
                t.contentType === "TIKTOK_VIDEO" ? video?.sizeBytes : undefined
              ),
            ] as const)
        )
      );
      const youtubeLive = new Map(
        await Promise.all(
          post.postTargets
            .filter((t) => t.platform === "YOUTUBE" && (t.status === "PUBLISHED" || t.status === "PLATFORM_SCHEDULED") && t.platformPostId)
            .map(async (t) => [t.id, await readYouTubeLive(t.socialAccount, t.platformPostId!, (iso) => fmt(new Date(iso)) ?? iso)] as const)
        )
      );
      // Statistiques Instagram déjà relevées (§43, lecture en base, aucun appel à Meta).
      const instagramStats = new Map(
        await Promise.all(
          post.postTargets
            // Stories : jamais relevées (Meta ne les liste pas et ne les garde que 24 h).
            .filter((t) => t.platform === "INSTAGRAM" && t.contentType !== "STORY" && t.status === "PUBLISHED" && t.platformPostId)
            .map(async (t) => [t.id, await getInstagramStatsForTarget(t.socialAccountId, t.platformPostId!)] as const)
        )
      );
      // Par où est passé le fichier de chaque livraison (journal d'activité, §36) — le plus récent gagne.
      const deliveryLogs = await db.activityLog.findMany({
        where: {
          userId,
          entityType: "PostTarget",
          entityId: { in: post.postTargets.map((t) => t.id) },
          action: { endsWith: "_published" },
        },
        orderBy: { createdAt: "desc" },
        select: { entityId: true, detail: true },
      });
      // Dernière réponse brute de YouTube pour une miniature en échec ou en attente (diagnostic).
      const thumbnailLogs = await db.activityLog.findMany({
        where: {
          userId,
          entityType: "PostTarget",
          entityId: { in: post.postTargets.filter((t) => t.platform === "YOUTUBE").map((t) => t.id) },
          action: { in: ["youtube_thumbnail_failed", "youtube_thumbnail_retry_scheduled", "youtube_thumbnail_set"] },
        },
        orderBy: { createdAt: "desc" },
        select: { entityId: true, action: true, detail: true },
      });
      const thumbnailApiErrors = new Map<string, string | undefined>();
      for (const log of thumbnailLogs) {
        if (thumbnailApiErrors.has(log.entityId)) continue;
        const raw = (log.detail as { rawError?: unknown } | null)?.rawError;
        thumbnailApiErrors.set(log.entityId, log.action === "youtube_thumbnail_set" || typeof raw !== "string" ? undefined : summarizeApiError(raw));
      }
      const deliveries = new Map<string, DeliveryPath>();
      const covers = new Map<string, CoverResult>();
      for (const log of deliveryLogs) {
        const delivery = readDelivery(log.detail);
        if (delivery && !deliveries.has(log.entityId)) deliveries.set(log.entityId, delivery);
        const cover = readCoverResult(log.detail);
        if (cover && !covers.has(log.entityId)) covers.set(log.entityId, cover);
      }
      return ok({
        post_id: post.id,
        status: post.status,
        scheduled_at: fmt(post.scheduledAt),
        caption: post.caption,
        hashtags: post.hashtags,
        media: post.postMedia.map((pm) => ({
          media_id: pm.mediaAsset.id,
          name: mediaName(pm.mediaAsset.storageKey),
          kind: pm.mediaAsset.mimeType.startsWith("video/") ? "video" : "image",
        })),
        targets: post.postTargets.map((t) => ({
          platform: t.platform,
          content_type: t.contentType,
          mode:
            t.publishMode === "TIKTOK_DRAFT"
              ? tiktokDraftTimingFromOptions(t.platformOptions) === "now"
                ? "brouillon TikTok (inbox), déposé dès la programmation"
                : "brouillon TikTok (inbox), déposé à l'heure prévue"
              : t.status === "PLATFORM_SCHEDULED"
                ? `programmée chez YouTube : vidéo déjà envoyée, privée, que YouTube rend publique le ${fmt(t.scheduledAt)}`
                : "publication directe",
          status: t.status,
          scheduled_at: fmt(t.scheduledAt),
          published_at: fmt(t.publishedAt),
          url: t.platformPostUrl ?? undefined,
          error: t.errorMessage ?? undefined,
          youtube_title: t.platform === "YOUTUBE" ? (t.platformOptions as { title?: string } | null)?.title : undefined,
          instagram_collaborators: t.platform === "INSTAGRAM" ? collaboratorsFromOptions(t.platformOptions) : undefined,
          instagram_trial_reel: t.platform === "INSTAGRAM" ? trialChoice(trialFromOptions(t.platformOptions)) : undefined,
          instagram_cover:
            t.platform === "INSTAGRAM" && t.contentType === "REEL" && (t.coverMediaAssetId || covers.has(t.id) || coverTimeFromOptions(t.platformOptions) != null)
              ? {
                  media_id: t.coverMediaAssetId ?? undefined,
                  name: t.coverMedia ? mediaName(t.coverMedia.storageKey) : undefined,
                  thumb_offset_ms: coverTimeFromOptions(t.platformOptions),
                  used: covers.has(t.id) ? describeCover(covers.get(t.id)!) : undefined,
                }
              : undefined,
          youtube_visibility: t.platform === "YOUTUBE" ? youtubePrivacyFromOptions(t.platformOptions) : undefined,
          youtube_thumbnail:
            t.platform === "YOUTUBE" && (t.coverMediaAssetId || t.thumbnailStatus)
              ? {
                  media_id: t.coverMediaAssetId ?? undefined,
                  name: t.coverMedia ? mediaName(t.coverMedia.storageKey) : undefined,
                  status: t.thumbnailStatus ?? "PENDING",
                  error: t.thumbnailError ?? undefined,
                  note:
                    t.thumbnailStatus === "SET" && t.contentType === "YOUTUBE_SHORT"
                      ? "Acceptée par l'API, mais YouTube ne l'affiche pas pour un Short (onglet Shorts, recherche) — vérifié les 13-14/10/2026 ; l'ajouter dans YouTube Studio pour qu'elle soit visible."
                      : (t.thumbnailStatus ?? "PENDING") === "PENDING" && !t.thumbnailError
                      ? t.status === "PUBLISHED" || t.status === "PLATFORM_SCHEDULED"
                        ? PROCESSING_NOTE
                        : "Sera posée après la mise en ligne de la vidéo, dès que YouTube a fini de la traiter."
                      : undefined,
                  api_error: t.thumbnailStatus !== "SET" ? thumbnailApiErrors.get(t.id) : undefined,
                  set_at: fmt(t.thumbnailSetAt) ?? undefined,
                }
              : undefined,
          youtube_live: youtubeLive.get(t.id),
          instagram_stats: instagramStats.has(t.id)
            ? instagramStats.get(t.id)
              ? instagramStatsView(instagramStats.get(t.id)!, fmt)
              : "pas encore relevées (relevé toutes les 6 h, après autorisation des statistiques)"
            : undefined,
          tiktok_reception: receptions.get(t.id),
          delivered_via: deliveries.get(t.id)?.via,
          delivery: deliveries.has(t.id) ? describeDelivery(deliveries.get(t.id)!) : undefined,
        })),
        created_at: fmt(post.createdAt),
        updated_at: fmt(post.updatedAt),
      });
    }
  );

  server.registerTool(
    "get_media",
    {
      title: "État d'un média",
      description: "Statut d'un média (importing, ready, failed + raison) et ses caractéristiques — pour suivre un import_media_from_url.",
      inputSchema: { media_id: z.string().min(1) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ media_id }) => {
      const m = await db.mediaAsset.findFirst({ where: { id: media_id, userId } });
      if (!m) return fail("Média introuvable.");
      const status = m.status === "READY" ? "ready" : m.status === "FAILED" ? "failed" : "importing";
      return ok({
        media_id: m.id,
        status,
        error: m.importError ?? undefined,
        name: status === "ready" ? mediaName(m.storageKey) : undefined,
        kind: status === "ready" ? (m.mimeType.startsWith("video/") ? "video" : "image") : undefined,
        size_mb: status === "ready" ? Math.round((m.sizeBytes / (1024 * 1024)) * 10) / 10 : undefined,
        duration_s: m.durationSec ?? undefined,
        width: m.width ?? undefined,
        height: m.height ?? undefined,
      });
    }
  );

  // ------------------------------------------------------------------ actions

  server.registerTool(
    "import_media_from_url",
    {
      title: "Importer un média depuis un lien",
      description:
        "Ajoute à la médiathèque une vidéo ou une image depuis un lien de partage PUBLIC (Google Drive « Tous les utilisateurs disposant du lien », Dropbox, ou lien https direct). L'import tourne en arrière-plan : suivre avec get_media jusqu'à status = ready, puis utiliser le media_id dans save_draft. Formats : MP4, MOV, WebM, JPEG, PNG, WebP ; 2 Go max.",
      inputSchema: {
        url: z.string().url().describe("Lien de partage public du FICHIER (pas d'un dossier)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ url }) => {
      const link = resolveShareLink(url);
      if (!link.ok) return fail(link.error);
      if (!checkRateLimit(`mcp-import:${userId}`, { max: 20, windowMs: 60 * 60 * 1000 }).allowed) {
        return fail("Trop d'imports en une heure, réessayez plus tard.");
      }
      const boss = getBoss();
      const asset = await db.$transaction(async (tx) => {
        const created = await tx.mediaAsset.create({
          data: {
            userId,
            storageKey: buildStorageKey(userId, "import-en-cours"),
            mimeType: "application/octet-stream",
            sizeBytes: 0,
            status: "UPLOADING",
            importUrl: url,
          },
        });
        // Enqueue transactionnel (règle d'ingénierie n°2) : pas de média « en cours » sans job réel.
        await boss.send(MEDIA_IMPORT_QUEUE, { mediaAssetId: created.id }, { db: dbFromPrismaTx(tx) });
        return created;
      });
      return ok({
        media_id: asset.id,
        status: "importing",
        source: link.provider,
        next: "Appeler get_media dans ~20 s (gros fichier : plusieurs minutes) jusqu'à status = ready.",
      });
    }
  );

  server.registerTool(
    "save_draft",
    {
      title: "Créer ou modifier un brouillon",
      description:
        "Crée un brouillon (sans post_id) ou modifie un brouillon existant (avec post_id). Ne publie ni ne programme rien : utiliser ensuite schedule_post ou publish_post_now. Au moins une plateforme requise.",
      inputSchema: {
        post_id: z.string().optional().describe("Brouillon existant à modifier (absent = nouveau)"),
        caption: z.string().max(2200).describe("Légende (hashtags à passer séparément)"),
        hashtags: z.array(z.string()).default([]).describe("Hashtags sans le #"),
        media_ids: z.array(z.string()).min(1).describe("Identifiants de médias (list_media), dans l'ordre d'affichage"),
        instagram: z.boolean().default(false),
        instagram_story: z.boolean().default(false).describe("Publier en Story plutôt qu'en post/Reel (1 seul média)"),
        tiktok: z.boolean().default(false).describe("Envoi en brouillon dans la boîte de réception TikTok"),
        tiktok_draft_timing: z
          .enum(TIKTOK_DRAFT_TIMINGS)
          .optional()
          .describe(
            "Moment du dépôt du brouillon TikTok : scheduled (défaut) = à l'heure programmée du post ; now = dès la programmation. Absent en modification = inchangé"
          ),
        youtube: z.boolean().default(false).describe("YouTube Short (exactement 1 vidéo)"),
        facebook: z
          .boolean()
          .default(false)
          .describe("Page Facebook : Reel si vidéo verticale de 3 à 90 s, sinon vidéo classique ; photo ou plusieurs photos (2 à 10)"),
        youtube_title: z.string().max(100).optional().describe("Titre YouTube (sinon 1re ligne de la légende)"),
        youtube_visibility: z
          .enum(YOUTUBE_PRIVACY_STATUSES)
          .optional()
          .describe(
            "Visibilité de la vidéo YouTube : public (défaut), unlisted (non répertoriée : visible seulement avec le lien, ni sur la chaîne ni dans la recherche) ou private. Absent en modification = inchangée"
          ),
        youtube_thumbnail_media_id: z
          .string()
          .min(1)
          .nullable()
          .optional()
          .describe(
            shortsThumbnailApiEnabled()
              ? "Miniature personnalisée du Short : media_id d'une IMAGE de la médiathèque (JPEG ou PNG, idéalement 1080×1920 ; recompressée en JPEG si plus de 2 Mo, jamais recadrée). Posée dès que YouTube a traité la vidéo ; un échec ne fait jamais échouer la vidéo (état dans get_post). null = retirer ; absent en modification = inchangée"
              : "DÉSACTIVÉ pour les Shorts (refusé) : YouTube n'affiche pas une miniature de Short envoyée par l'API. La miniature d'un Short s'ajoute dans YouTube Studio sur ordinateur."
          ),
        instagram_collaborators: z
          .array(z.string())
          .max(3)
          .optional()
          .describe("Jusqu'à 3 pseudos Instagram invités en collaboration (pas en Story)"),
        instagram_cover_media_id: z
          .string()
          .min(1)
          .nullable()
          .optional()
          .describe(
            "Reel Instagram : image de couverture (media_id d'une IMAGE de la médiathèque, 9:16 conseillé), prioritaire sur instagram_thumb_offset_ms. Si Instagram la refuse, le Reel part quand même avec une image de la vidéo. null = retirer ; absent en modification = inchangée"
          ),
        instagram_thumb_offset_ms: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Reel Instagram : image de la vidéo à utiliser comme couverture, en millisecondes depuis le début (ex. 900)"),
        instagram_trial_reel: z
          .enum(["manual", "auto"])
          .optional()
          .describe(
            "Réel d'essai Instagram : d'abord montré aux seuls non-abonnés. Reel d'une seule vidéo, hors Story, sans collaborateurs. manual = l'utilisateur le partage ensuite à ses abonnés depuis l'app Instagram ; auto = Instagram le partage tout seul s'il marche bien"
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      const result = await saveDraftForUser(userId, {
        postId: args.post_id ?? null,
        caption: args.caption,
        hashtags: args.hashtags.map((h) => h.trim().replace(/^#/, "")).filter(Boolean),
        mediaAssetIds: args.media_ids,
        targetInstagram: args.instagram || args.instagram_story,
        targetInstagramStory: args.instagram_story,
        targetTiktok: args.tiktok,
        tiktokDraftTiming: args.tiktok_draft_timing,
        targetYoutube: args.youtube,
        targetFacebook: args.facebook,
        youtubeTitle: args.youtube_title ?? null,
        instagramCollaborators: args.instagram_collaborators ?? null,
        instagramTrial: args.instagram_trial_reel ? TRIAL_STRATEGY_BY_CHOICE[args.instagram_trial_reel] : null,
        instagramCoverTimeMs: args.instagram_thumb_offset_ms ?? null,
        // undefined (paramètre absent) = garder la valeur du brouillon ; null = retirer.
        instagramCoverMediaId: args.instagram_cover_media_id,
        youtubeThumbnailMediaId: args.youtube_thumbnail_media_id,
        youtubePrivacy: args.youtube_visibility,
      });
      if (result.error || !result.postId) return fail(result.error ?? "Enregistrement impossible.");
      return ok({ post_id: result.postId, status: "DRAFT", next: "schedule_post ou publish_post_now" });
    }
  );

  server.registerTool(
    "set_youtube_thumbnail",
    {
      title: "Poser la miniature d'un Short YouTube",
      description:
        shortsThumbnailApiEnabled()
          ? "Pose ou remplace la miniature personnalisée de la vidéo YouTube d'un post Social Master — notamment d'une vidéo DÉJÀ publiée (corriger d'anciens Shorts). media_id = une IMAGE de la médiathèque (envoyée avec upload_local_media ou import_media_from_url). Vidéo publiée et traitée par YouTube : envoi immédiat, résultat SET, FAILED (raison claire : chaîne non éligible ou non vérifiée, image invalide…) ou PENDING (erreur passagère : nouvel essai automatique dans 5 min). Vidéo encore en traitement (YouTube refuse alors toute miniature) ou pas encore publiée : PENDING, l'image est posée dès que la vidéo est prête — suivre avec get_post. Change ce que voient les spectateurs : confirmer avec l'utilisateur avant d'appeler."
          : "DÉSACTIVÉ pour les Shorts (renvoie une erreur) : YouTube n'affiche pas une miniature de Short envoyée par l'API (vérifié les 13-14/10/2026). La miniature d'un Short s'ajoute dans YouTube Studio sur ordinateur (Contenus → Shorts → le Short → Miniature → Importer).",
      inputSchema: {
        post_id: z.string().min(1),
        media_id: z.string().min(1).describe("Image de la médiathèque (JPEG ou PNG idéalement, 1080×1920 pour un Short)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ post_id, media_id }) => {
      const result = await requestYouTubeThumbnailForUser(userId, post_id, media_id);
      if (result.error || !result.outcome) return fail(result.error ?? "Miniature impossible à poser.");
      const outcome = result.outcome;
      if (outcome.status === "FAILED") return fail(outcome.message);
      return ok({
        post_id,
        media_id,
        video_url: result.videoUrl ?? undefined,
        status: outcome.status === "SKIPPED" ? "PENDING" : outcome.status,
        ...(outcome.status === "SET"
          ? {
              thumbnails: outcome.urls,
              recompressed: outcome.recompressed || undefined,
              note: "Miniature acceptée par YouTube. L'affichage peut mettre quelques minutes à se mettre à jour (cache).",
            }
          : { note: outcome.status === "PENDING" ? outcome.message : outcome.reason }),
      });
    }
  );

  // ------------------------------------------------- vidéos déjà sur YouTube (§39)

  const isoLocal = (iso: string | undefined) => (iso ? fmt(new Date(iso)) ?? iso : undefined);
  const editNote = (scope: EditScope | undefined) =>
    scope === "missing" ? `${RECONNECT_FOR_EDIT_MESSAGE} Lien : ${app}/connections` : undefined;
  const videoSummary = (v: YouTubeVideoDetails & { postId?: string }) => ({
    video_id: v.id,
    url: `https://youtu.be/${v.id}`,
    title: v.title,
    visibility: v.privacyStatus,
    scheduled_for: isoLocal(v.publishAt),
    published_at: v.privacyStatus !== "private" ? isoLocal(v.publishedAt) : undefined,
    duration_s: v.durationSec,
    post_id: v.postId,
  });
  const shorten = (text: string) => (text.length > 500 ? `${text.slice(0, 500)}…` : text);
  const changeView = (c: VideoChange) => ({
    field: c.field,
    before: c.field === "publish_at" ? (isoLocal(c.before) ?? "aucune") : shorten(c.before),
    after: c.field === "publish_at" ? isoLocal(c.after) : shorten(c.after),
  });
  const VIDEO_REF = {
    video: z.string().min(1).optional().describe("Lien de la vidéo (youtube.com/shorts/…, watch?v=…, youtu.be/…, Studio) ou son identifiant"),
    post_id: z.string().min(1).optional().describe("Ou : le post Social Master qui a publié la vidéo"),
  };

  server.registerTool(
    "list_youtube_videos",
    {
      title: "Lister les vidéos de la chaîne YouTube",
      description:
        "Dernières vidéos de la chaîne YouTube connectée, de la plus récente à la plus ancienne (publiques, non répertoriées, privées et programmées ; publiées par Social Master ou non) : identifiant, titre, visibilité, date, durée, post Social Master éventuel. Pour retrouver la vidéo à modifier avec update_youtube_video. 3 unités de quota YouTube.",
      inputSchema: { limit: z.number().int().min(1).max(50).default(15) },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ limit }) => {
      const result = await listYouTubeVideosForUser(userId, limit);
      if (result.error || !result.videos) return fail(result.error ?? "Lecture impossible.");
      return ok({
        channel: result.channel,
        can_edit: result.editScope !== "missing",
        note: editNote(result.editScope),
        videos: result.videos.map(videoSummary),
      });
    }
  );

  server.registerTool(
    "get_youtube_video",
    {
      title: "Détail d'une vidéo YouTube",
      description:
        "Une vidéo de la chaîne connectée telle que YouTube l'affiche maintenant : titre, description COMPLÈTE, tags, visibilité, date de publication programmée, durée, post Social Master éventuel. À lire avant update_youtube_video, qui remplace la description et les tags en entier. Indiquer video (lien ou identifiant) ou post_id. 1 unité de quota.",
      inputSchema: VIDEO_REF,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ video, post_id }) => {
      const result = await getYouTubeVideoForUser(userId, { video, postId: post_id });
      if (result.error || !result.video) return fail(result.error ?? "Lecture impossible.");
      const v = result.video;
      return ok({
        ...videoSummary({ ...v, postId: result.postId }),
        channel: result.channel,
        social_master_status: result.targetStatus,
        description: v.description,
        description_bytes: utf8Bytes(v.description),
        tags: v.tags,
        tags_length: tagsLength(v.tags),
        category_id: v.categoryId,
        made_for_kids: v.madeForKids,
        upload_status: v.uploadStatus,
        can_edit: result.editScope !== "missing",
        note: editNote(result.editScope),
      });
    }
  );

  server.registerTool(
    "update_youtube_video",
    {
      title: "Modifier une vidéo YouTube",
      description:
        "Modifie une vidéo DÉJÀ sur YouTube (publiée, non répertoriée, privée ou programmée), publiée par Social Master ou non — vidéo de la chaîne connectée uniquement. Seuls les champs indiqués changent, tout le reste est conservé. title ≤ 100 caractères ; description ≤ 5000 octets et tags ≤ 500 caractères au total REMPLACENT entièrement les actuels (lire get_youtube_video d'abord ; garder les hashtags voulus dans la description) ; tags = [] les retire. visibility « public » sur une vidéo programmée = publication IMMÉDIATE. publish_at = nouvelle date d'une vidéo privée jamais publiée (programmée) ; pour décaler aussi Instagram/TikTok d'un post, utiliser plutôt reschedule_post. Le fichier vidéo ne peut pas être remplacé (YouTube ne le permet pas). Change ce que voient les spectateurs : montrer à l'utilisateur chaque changement (avant → après) et obtenir sa confirmation avant d'appeler. 50 unités de quota YouTube (10 000 par jour).",
      inputSchema: {
        ...VIDEO_REF,
        title: z.string().optional().describe("Nouveau titre (≤ 100 caractères, ni < ni >)"),
        description: z.string().optional().describe("Nouvelle description COMPLÈTE (≤ 5000 octets, ni < ni >)"),
        tags: z.array(z.string()).optional().describe("Nouveaux tags (mots-clés, sans #) — remplacent les actuels ; [] = aucun"),
        visibility: z
          .enum(YOUTUBE_PRIVACY_STATUSES)
          .optional()
          .describe("public, unlisted (non répertoriée : visible seulement avec le lien) ou private"),
        publish_at: DATETIME_LOCAL.optional().describe(
          "Nouvelle date de publication d'une vidéo programmée (privée, jamais publiée), heure LOCALE AAAA-MM-JJTHH:mm"
        ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ video, post_id, title, description, tags, visibility, publish_at }) => {
      const publishAt = publish_at ? fromZonedTime(publish_at, tz) : undefined;
      if (publishAt && Number.isNaN(publishAt.getTime())) return fail("Date de publication invalide.");
      const result = await updateYouTubeVideoForUser(userId, { video, postId: post_id }, { title, description, tags, privacy: visibility, publishAt });
      if (result.error || !result.video) {
        return fail(`${result.error ?? "Modification impossible."}${result.code === "yt_edit_scope" ? ` Lien : ${app}/connections` : ""}`);
      }
      return ok({
        ...videoSummary({ ...result.video, postId: result.postId }),
        channel: result.channel,
        changed: (result.changes ?? []).map(changeView),
        notes: result.notes,
      });
    }
  );

  server.registerTool(
    "schedule_post",
    {
      title: "Programmer un brouillon",
      description:
        "Programme un brouillon à une heure locale. Instagram partira publiquement à cette heure ; le brouillon TikTok est déposé dans la boîte de réception TikTok à cette heure (ou tout de suite si tiktok_draft_timing = now). YouTube (vidéo publique programmée au moins 15 min à l'avance) : la vidéo part TOUT DE SUITE chez YouTube, en privé avec cette date de publication — sa miniature est posée dès qu'elle est traitée et c'est YouTube qui la rend publique à l'heure prévue (cible « PLATFORM_SCHEDULED » dans get_post, puis « PUBLISHED »). Confirmer avec l'utilisateur avant d'appeler.",
      inputSchema: { post_id: z.string().min(1), datetime: DATETIME_LOCAL },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ post_id, datetime }) => {
      const result = await schedulePostForUser(userId, post_id, datetime, tz);
      return result.error ? fail(result.error) : ok({ post_id, status: "SCHEDULED", scheduled_at: `${datetime.replace("T", " ")} (${tz})` });
    }
  );

  server.registerTool(
    "reschedule_post",
    {
      title: "Changer l'horaire",
      description:
        "Déplace un post DÉJÀ programmé à une nouvelle heure locale (les décalages entre plateformes sont conservés). Une vidéo déjà programmée chez YouTube y est déplacée sur place (même vidéo, miniature posée dans Studio conservée) ; si la connexion YouTube n'a pas encore le droit de modification (Connexions → YouTube → « Reconnecter »), elle y est supprimée (elle n'a jamais été publique) puis renvoyée pour le nouvel horaire.",
      inputSchema: { post_id: z.string().min(1), datetime: DATETIME_LOCAL },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ post_id, datetime }) => {
      const result = await reschedulePostForUser(userId, post_id, datetime, tz);
      return result.error ? fail(result.error) : ok({ post_id, status: "SCHEDULED", scheduled_at: `${datetime.replace("T", " ")} (${tz})` });
    }
  );

  server.registerTool(
    "unschedule_post",
    {
      title: "Annuler la programmation",
      description:
        "Repasse un post programmé (ou en échec) en brouillon. Les plateformes déjà publiées ne sont pas touchées. Une vidéo déjà programmée chez YouTube (privée, pas encore publiée) y est supprimée ; si YouTube est injoignable, rien n'est modifié et l'outil renvoie une erreur.",
      inputSchema: { post_id: z.string().min(1) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ post_id }) => {
      const result = await unschedulePostForUser(userId, post_id);
      return result.error ? fail(result.error) : ok({ post_id, status: "DRAFT" });
    }
  );

  server.registerTool(
    "publish_post_now",
    {
      title: "Publier maintenant",
      description:
        "Publie IMMÉDIATEMENT un brouillon : publication PUBLIQUE et irréversible sur Instagram/YouTube, brouillon TikTok envoyé dans la boîte de réception. Toujours obtenir la confirmation explicite de l'utilisateur avant d'appeler.",
      inputSchema: { post_id: z.string().min(1) },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ post_id }) => {
      const result = await publishPostNowForUser(userId, post_id, tz);
      return result.error
        ? fail(result.error)
        : ok({ post_id, status: "SCHEDULED", note: "Publication lancée : suivre l'avancement avec get_post dans une à deux minutes." });
    }
  );

  server.registerTool(
    "get_instagram_stats",
    {
      title: "Statistiques Instagram",
      description:
        "Statistiques du compte Instagram connecté, relevées par Social Master toutes les 6 h (pas en direct) : pour chaque Reel ou publication (publié par Social Master ou non) vues, portée, likes, commentaires, partages, enregistrements, interactions, et pour un Reel temps de visionnage moyen et taux de zapping des 3 premières secondes (skip_rate_pct) ; vues et portée du compte jour par jour (journées Meta). media_total = nombre de médias de la période (la liste est limitée à limit : truncated). media = un identifiant de média, un post_id Social Master ou un lien instagram.com pour un seul média ; history (avec media seulement) = relevés successifs, la courbe des vues dans le temps.",
      inputSchema: {
        days: z.number().int().min(1).max(365).default(30).describe("Médias publiés depuis N jours, et N jours de statistiques du compte (90 max)."),
        limit: z.number().int().min(1).max(100).default(30),
        sort: z.enum(["recent", "views"]).default("recent"),
        history: z.boolean().default(false),
        media: z.string().min(1).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ days, limit, sort, history, media }) => {
      if (history && !media) return fail("history n'est disponible que pour un seul média : préciser media (identifiant, post_id ou lien).");
      let mediaId: string | undefined;
      if (media) {
        const target = await db.postTarget.findFirst({
          where: { postId: media, platform: "INSTAGRAM", post: { userId } },
          select: { platformPostId: true },
        });
        if (target) {
          if (!target.platformPostId) return fail("Ce post n'est pas encore publié sur Instagram.");
          mediaId = target.platformPostId;
        } else if (media.startsWith("http")) {
          // Lien collé depuis l'app (/reel/…, /p/…, avec ou sans pseudo ni ?igsh=) : on compare le code court.
          const shortcode = media.match(/\/(?:reels?|p|tv)\/([A-Za-z0-9_-]+)/)?.[1];
          const found = shortcode
            ? await db.instagramMedia.findFirst({
                where: {
                  OR: [{ permalink: { contains: `/${shortcode}/` } }, { permalink: { endsWith: `/${shortcode}` } }],
                  socialAccount: { userId },
                },
                select: { mediaId: true },
              })
            : null;
          if (!found) return fail("Lien inconnu : ce média n'a pas encore été relevé (ou n'appartient pas au compte connecté).");
          mediaId = found.mediaId;
        } else {
          mediaId = media;
        }
      }
      const stats = await getInstagramStatsForUser(userId, { days, limit, sort, history, mediaId });
      if (!stats.account) return fail("Aucun compte Instagram connecté.");
      const state = stats.account.state;
      return ok({
        account: `@${stats.account.username}`,
        stats_permission: stats.account.scope,
        ...(stats.account.scope === "missing" ? { action_required: RECONNECT_FOR_STATS_MESSAGE } : {}),
        last_collection: stats.account.collecting
          ? "premier relevé en cours (quelques minutes après la reconnexion), réessayer ensuite"
          : state
            ? {
                at: fmt(new Date(state.lastRunAt)),
                ok: state.ok,
                ...(state.error ? { error: state.error } : {}),
                ...(state.mediaPending ? { media_waiting: state.mediaPending } : {}),
              }
            : "aucun relevé pour l'instant",
        caveats: STATS_CAVEATS,
        ...(mediaId
          ? {}
          : {
              account_views: {
                last_7_days: { views: stats.totals?.views7d.value ?? null, days_with_data: stats.totals?.views7d.daysWithData ?? 0 },
                last_30_days: { views: stats.totals?.views30d.value ?? null, days_with_data: stats.totals?.views30d.daysWithData ?? 0 },
              },
              account_days: stats.days.slice(-Math.min(days, 90)).map((d) => ({
                day: d.day,
                views: d.views,
                reach: d.reach,
                ...(d.metrics.accounts_engaged != null ? { accounts_engaged: d.metrics.accounts_engaged } : {}),
                ...(d.metrics.total_interactions != null ? { total_interactions: d.metrics.total_interactions } : {}),
              })),
            }),
        media_total: stats.mediaTotal,
        ...(stats.mediaTotal > stats.media.length ? { truncated: true } : {}),
        media: stats.media.map((m) => instagramStatsView(m, fmt)),
      });
    }
  );

  server.registerTool(
    "refresh_instagram_stats",
    {
      title: "Relever les statistiques Instagram maintenant",
      description:
        "Lance tout de suite un relevé des statistiques Instagram (sinon automatique toutes les 6 h). Résultat dans 1 à 3 minutes avec get_instagram_stats (premier relevé : jusqu'à plusieurs minutes, tout l'historique du compte). N'écrit rien chez Instagram.",
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async () => {
      const account = await db.socialAccount.findFirst({
        where: { userId, platform: "INSTAGRAM" },
        select: { id: true, status: true, grantedScopes: true },
      });
      if (!account) return fail("Aucun compte Instagram connecté.");
      if (account.status !== "ACTIVE") return fail("Le compte Instagram doit être reconnecté (Connexions → Instagram → Reconnecter).");
      if (insightsScopeStatus(account.grantedScopes) === "missing") return fail(RECONNECT_FOR_STATS_MESSAGE);
      const queued = await requestInstagramStats(account.id);
      return ok({
        queued,
        note: queued
          ? "Relevé lancé : consulter get_instagram_stats dans 1 à 3 minutes."
          : "Un relevé est déjà en attente ou en cours : consulter get_instagram_stats dans quelques minutes.",
      });
    }
  );

  return server;
}
