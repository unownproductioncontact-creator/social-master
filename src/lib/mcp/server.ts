import "server-only";
import * as z from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { formatInTimeZone } from "date-fns-tz";
import { db } from "@/lib/db";
import {
  publishPostNowForUser,
  reschedulePostForUser,
  saveDraftForUser,
  schedulePostForUser,
  unschedulePostForUser,
} from "@/lib/post-service";
import { collaboratorsFromOptions } from "@/lib/instagram-collaborators";
import { appUrl } from "@/lib/app-url";
import { buildStorageKey } from "@/lib/storage";
import { resolveShareLink } from "@/lib/media-import/share-link";
import { checkRateLimit } from "@/lib/rate-limit";
import { decryptToken } from "@/lib/crypto";
import { fetchTikTokPublishStatus } from "@/lib/providers/tiktok";
import { tiktokReception } from "@/lib/tiktok-draft";
import { dbFromPrismaTx, getBoss, MEDIA_IMPORT_QUEUE } from "@/worker/boss";

/**
 * Serveur MCP du connecteur Claude (CLAUDE.md §29) — un serveur par requête (transport sans état),
 * TOUTES les requêtes scopées par le `userId` du jeton OAuth (règle d'ingénierie n°10). Les actions
 * réutilisent la logique métier du composer (post-service) : mêmes validations, mêmes garde-fous
 * (anti-double publication, quotas TikTok, fenêtre ≥ 60 s…).
 */

function instructions(app: string): string {
  return `Social Master planifie les publications Instagram, TikTok et YouTube Shorts de l'utilisateur. Adresse de l'app : ${app} (seule adresse valide — ne pas en proposer d'autre).
- Les heures sont TOUJOURS exprimées dans le fuseau de l'utilisateur (indiqué par get_overview), au format « AAAA-MM-JJTHH:mm » en entrée.
- TikTok : la vidéo est déposée en BROUILLON dans la boîte de réception TikTok de l'utilisateur, qui la publie lui-même depuis l'app (immédiatement, même si le post est programmé plus tard).
- Instagram et YouTube : publication PUBLIQUE et automatique à l'heure prévue (ou tout de suite avec publish_post_now).
- Médias : utiliser ceux de la médiathèque (list_media). Pour un NOUVEAU média, demander à l'utilisateur un lien de partage PUBLIC (Google Drive « Tous les utilisateurs disposant du lien », Dropbox, ou lien direct https) puis appeler import_media_from_url, et suivre l'import avec get_media (quelques secondes à quelques minutes). Une pièce jointe de la conversation ne peut PAS être transmise. Alternative : import manuel sur ${app}/library.
- Avant toute action qui publie ou programme, résume à l'utilisateur ce qui va partir (plateformes, heure, légende) et attends sa confirmation.`;
}

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: `Erreur : ${message}` }], isError: true };
}

/**
 * Ce que TikTok a réellement reçu pour un envoi (statut + octets reçus vs taille du fichier), lu EN DIRECT
 * — pour vérifier qu'un brouillon est arrivé entier. Jamais bloquant : erreur lisible si TikTok ne répond pas.
 */
async function readTikTokReception(accessTokenEnc: string, publishId: string, expectedBytes: number | undefined) {
  try {
    const state = await fetchTikTokPublishStatus(decryptToken(accessTokenEnc), publishId, AbortSignal.timeout(5000));
    return {
      tiktok_status: state.status,
      ...tiktokReception(state.uploadedBytes, expectedBytes),
      fail_reason: state.failReason,
    };
  } catch {
    return { error: "Statut TikTok illisible pour l'instant (jeton expiré ou TikTok injoignable)." };
  }
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
        include: { _count: { select: { postMedia: true } } },
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
        "Tout le détail d'un post : légende, hashtags, médias, cibles par plateforme (options, statut, erreur, lien). Pour un envoi TikTok : tiktok_reception = ce que TikTok a réellement reçu (received_bytes doit égaler expected_bytes).",
      inputSchema: { post_id: z.string().min(1) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ post_id }) => {
      const post = await db.post.findFirst({
        where: { id: post_id, userId },
        include: {
          postMedia: { include: { mediaAsset: true }, orderBy: { position: "asc" } },
          postTargets: { include: { socialAccount: true } },
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
                t.socialAccount.accessTokenEnc,
                t.tiktokPublishId!,
                t.contentType === "TIKTOK_VIDEO" ? video?.sizeBytes : undefined
              ),
            ] as const)
        )
      );
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
          mode: t.publishMode === "TIKTOK_DRAFT" ? "brouillon TikTok (inbox)" : "publication directe",
          status: t.status,
          scheduled_at: fmt(t.scheduledAt),
          published_at: fmt(t.publishedAt),
          url: t.platformPostUrl ?? undefined,
          error: t.errorMessage ?? undefined,
          youtube_title: t.platform === "YOUTUBE" ? (t.platformOptions as { title?: string } | null)?.title : undefined,
          instagram_collaborators: t.platform === "INSTAGRAM" ? collaboratorsFromOptions(t.platformOptions) : undefined,
          tiktok_reception: receptions.get(t.id),
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
        youtube: z.boolean().default(false).describe("YouTube Short (exactement 1 vidéo)"),
        youtube_title: z.string().max(100).optional().describe("Titre YouTube (sinon 1re ligne de la légende)"),
        instagram_collaborators: z
          .array(z.string())
          .max(3)
          .optional()
          .describe("Jusqu'à 3 pseudos Instagram invités en collaboration (pas en Story)"),
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
        targetYoutube: args.youtube,
        youtubeTitle: args.youtube_title ?? null,
        instagramCollaborators: args.instagram_collaborators ?? null,
      });
      if (result.error || !result.postId) return fail(result.error ?? "Enregistrement impossible.");
      return ok({ post_id: result.postId, status: "DRAFT", next: "schedule_post ou publish_post_now" });
    }
  );

  server.registerTool(
    "schedule_post",
    {
      title: "Programmer un brouillon",
      description:
        "Programme un brouillon à une heure locale. Instagram/YouTube partiront publiquement à cette heure ; TikTok reçoit le brouillon immédiatement. Confirmer avec l'utilisateur avant d'appeler.",
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
      description: "Déplace un post DÉJÀ programmé à une nouvelle heure locale (les décalages entre plateformes sont conservés).",
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
      description: "Repasse un post programmé (ou en échec) en brouillon. Les plateformes déjà publiées ne sont pas touchées.",
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

  return server;
}
