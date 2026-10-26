import "server-only";
import { db } from "@/lib/db";
import {
  insightsScopeStatus,
  captionExcerpt,
  watchTimeSeconds,
  skipRatePercent,
  metaToday,
  shiftDay,
  type InstagramStatsState,
} from "@/lib/instagram-stats";

/**
 * Lecture des statistiques Instagram déjà relevées (CLAUDE.md §43) — aucun appel à Meta ici : le
 * connecteur et les pages lisent la base, le job de relevé l'alimente. Toujours scopé par userId.
 */

export type InstagramMediaStatsView = {
  mediaId: string;
  type: string | null;
  postedAt: Date;
  permalink: string | null;
  caption: string | null;
  postId: string | null;
  views: number | null;
  reach: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saved: number | null;
  totalInteractions: number | null;
  avgWatchSeconds: number | null;
  totalWatchSeconds: number | null;
  skipRatePct: number | null;
  missing: string[];
  fetchedAt: Date | null;
  error: string | null;
  history?: Array<{ fetchedAt: Date; ageHours: number; metrics: Record<string, number> }>;
};

type MediaRow = Awaited<ReturnType<typeof db.instagramMedia.findMany>>[number] & {
  snapshots?: Array<{ fetchedAt: Date; metrics: unknown }>;
};

function toView(
  m: MediaRow,
  link: { postId: string; caption: string } | undefined,
  maxSkipRaw: number | null
): InstagramMediaStatsView {
  return {
    mediaId: m.mediaId,
    type: m.mediaProductType,
    postedAt: m.postedAt,
    permalink: m.permalink,
    caption: captionExcerpt(m.caption ?? link?.caption),
    postId: link?.postId ?? null,
    views: m.views,
    reach: m.reach,
    likes: m.likes,
    comments: m.comments,
    shares: m.shares,
    saved: m.saved,
    totalInteractions: m.totalInteractions,
    avgWatchSeconds: watchTimeSeconds(m.avgWatchTime),
    totalWatchSeconds: watchTimeSeconds(m.totalWatchTime),
    skipRatePct: skipRatePercent(m.skipRate, maxSkipRaw),
    missing: m.missingMetrics,
    fetchedAt: m.statsFetchedAt,
    error: m.statsError,
    ...(m.snapshots
      ? {
          history: m.snapshots.map((s) => ({
            fetchedAt: s.fetchedAt,
            ageHours: Math.round((s.fetchedAt.getTime() - m.postedAt.getTime()) / 360_000) / 10,
            metrics: (s.metrics ?? {}) as Record<string, number>,
          })),
        }
      : {}),
  };
}

/** Post Social Master (et sa légende) derrière chaque média publié par l'app. */
async function postLinks(socialAccountId: string, mediaIds: string[]) {
  if (mediaIds.length === 0) return new Map<string, { postId: string; caption: string }>();
  const targets = await db.postTarget.findMany({
    where: { platform: "INSTAGRAM", socialAccountId, platformPostId: { in: mediaIds } },
    select: { platformPostId: true, postId: true, post: { select: { caption: true } } },
  });
  return new Map(targets.map((t) => [t.platformPostId!, { postId: t.postId, caption: t.post.caption }]));
}

/** Échelle du taux de zapping, choisie une fois pour tout le compte (voir skipRatePercent). */
async function maxSkipRate(socialAccountId: string): Promise<number | null> {
  const agg = await db.instagramMedia.aggregate({ where: { socialAccountId }, _max: { skipRate: true } });
  return agg._max.skipRate ?? null;
}

/** Somme des vues des journées relevées ; null (pas 0) quand aucune journée n'a été relevée. */
function sumViews(days: Array<{ day: string; views: number | null }>, from: string, to: string) {
  const inRange = days.filter((d) => d.day >= from && d.day <= to && d.views != null);
  return { value: inRange.length > 0 ? inRange.reduce((s, d) => s + (d.views ?? 0), 0) : null, daysWithData: inRange.length };
}

export async function getInstagramStatsForUser(
  userId: string,
  opts: { days?: number; limit?: number; sort?: "recent" | "views"; history?: boolean; mediaId?: string; now?: Date } = {}
) {
  const now = opts.now ?? new Date();
  const days = opts.days ?? 30;
  const account = await db.socialAccount.findFirst({
    where: { userId, platform: "INSTAGRAM" },
    select: { id: true, username: true, status: true, grantedScopes: true, metadata: true },
  });
  if (!account) return { account: null, media: [], mediaTotal: 0, days: [], totals: null };

  const state = ((account.metadata as { instagramStats?: InstagramStatsState } | null)?.instagramStats ?? null) as InstagramStatsState | null;
  const scope = insightsScopeStatus(account.grantedScopes);
  const since = new Date(now.getTime() - days * 86_400_000);
  const where = {
    socialAccountId: account.id,
    mediaProductType: { in: ["REELS", "FEED"] },
    ...(opts.mediaId ? { mediaId: opts.mediaId } : { postedAt: { gte: since } }),
  };
  const mediaTotal = await db.instagramMedia.count({ where });
  const rows = (await db.instagramMedia.findMany({
    where,
    orderBy: opts.sort === "views" ? [{ views: { sort: "desc", nulls: "last" } }, { postedAt: "desc" }] : { postedAt: "desc" },
    take: Math.min(opts.limit ?? 30, 200),
    ...(opts.history ? { include: { snapshots: { orderBy: { fetchedAt: "asc" }, take: 120 } } } : {}),
  })) as MediaRow[];
  const links = await postLinks(account.id, rows.map((r) => r.mediaId));
  const skipMax = await maxSkipRate(account.id);

  // Au moins 30 journées chargées : les totaux 7 j / 30 j ne dépendent pas de la période demandée.
  const today = metaToday(now);
  const firstDay = shiftDay(today, -Math.min(Math.max(days, 30), 90));
  const dayRows = await db.instagramAccountDay.findMany({
    where: { socialAccountId: account.id, day: { gte: firstDay, lt: today } },
    orderBy: { day: "asc" },
    select: { day: true, views: true, reach: true, metrics: true },
  });
  const yesterday = shiftDay(today, -1);

  return {
    account: {
      id: account.id,
      username: account.username,
      status: account.status,
      scope,
      state,
      // Reconnexion faite, premier relevé pas encore terminé : l'ancien « non autorisé » est périmé.
      collecting: scope !== "missing" && (!state || state.errorKind === "missing_scope"),
    },
    media: rows.map((r) => toView(r, links.get(r.mediaId), skipMax)),
    mediaTotal,
    days: dayRows
      .filter((d) => d.day >= shiftDay(today, -Math.min(Math.max(days, 1), 90)))
      .map((d) => ({ day: d.day, views: d.views, reach: d.reach, metrics: (d.metrics ?? {}) as Record<string, number> })),
    totals: {
      views7d: sumViews(dayRows, shiftDay(today, -7), yesterday),
      views30d: sumViews(dayRows, shiftDay(today, -30), yesterday),
    },
  };
}

/** Statistiques du média Instagram d'une cible publiée (page du post, get_post). null si pas encore relevé. */
export async function getInstagramStatsForTarget(socialAccountId: string, mediaId: string): Promise<InstagramMediaStatsView | null> {
  const row = await db.instagramMedia.findUnique({
    where: { socialAccountId_mediaId: { socialAccountId, mediaId } },
  });
  return row ? toView(row, undefined, await maxSkipRate(socialAccountId)) : null;
}
