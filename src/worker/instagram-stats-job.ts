import "server-only";
import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { decryptToken } from "@/lib/crypto";
import {
  listInstagramMediaPage,
  fetchInstagramMediaInsights,
  fetchInstagramAccountTotals,
  MEDIA_LIST_FIELDS,
  MEDIA_LIST_FIELDS_FALLBACK,
  type ListedInstagramMedia,
} from "@/lib/providers/instagram";
import {
  insightsScopeStatus,
  metricAttemptsFor,
  classifyListedMedia,
  parseMediaInsights,
  mediaStatsColumns,
  statsRefreshDue,
  classifyInsightsError,
  accountDaysToFetch,
  metaToday,
  metaDayWindow,
  parseAccountTotals,
  ACCOUNT_DAY_METRICS,
  ACCOUNT_DAY_FALLBACK_METRICS,
  type InsightsErrorKind,
  type InstagramStatsState,
} from "@/lib/instagram-stats";

/**
 * Relevé des statistiques Instagram (CLAUDE.md §43). Ordre : (1) liste des médias, (2) statistiques du compte
 * jour par jour — qui confirment au passage le droit de lire les statistiques —, (3) statistiques des Reels et
 * publications dont le relevé est dû. Toutes les 6 h (cron, un job par compte) et juste après une
 * (re)connexion Instagram. Ne lève jamais pour une erreur de Meta : l'état est noté dans
 * `SocialAccount.metadata.instagramStats`, et un problème de statistiques ne touche JAMAIS au statut du compte.
 */

export type InstagramStatsJobData = { socialAccountId?: string };

/** Liste complète (tant que l'historique n'a pas été parcouru jusqu'au bout) : 10 000 médias au plus chez Meta. */
const FULL_LISTING_MAX_PAGES = 40;
/** Passages suivants : les nouveautés seulement (on s'arrête aux médias de plus de 30 jours). */
const NEXT_RUN_MAX_PAGES = 4;
const NEXT_RUN_LISTING_DAYS = 30;
/** Plafond par passage : le reste attend le passage suivant (6 h plus tard). */
const MAX_MEDIA_PER_RUN = 200;
/** Erreurs passagères de suite avant d'arrêter une phase (Meta lent ou en panne : inutile d'insister). */
const MAX_CONSECUTIVE_ERRORS = 3;
/** Durée max d'un passage : le job expire à 30 min (pg-boss) ; on s'arrête proprement avant. */
const RUN_BUDGET_MS = 25 * 60_000;

type Account = { id: string; userId: string; platformAccountId: string; accessTokenEnc: string; grantedScopes: string[]; metadata: unknown };
type Ctx = { account: Account; token: string; now: Date; deadline: number; prev: Partial<InstagramStatsState> };
type PhaseError = { message: string; raw: string };

class AbortAccount extends Error {
  constructor(
    readonly kind: InsightsErrorKind,
    message: string,
    readonly raw: string
  ) {
    super(message);
  }
}

const rawOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

function previousState(metadata: unknown): Partial<InstagramStatsState> {
  const state = (metadata as { instagramStats?: unknown } | null)?.instagramStats;
  return state && typeof state === "object" ? (state as Partial<InstagramStatsState>) : {};
}

async function saveState(accountId: string, state: InstagramStatsState) {
  // Relecture juste avant l'écriture : `metadata` porte d'autres clés qu'on ne doit pas écraser.
  const fresh = await db.socialAccount.findUnique({ where: { id: accountId }, select: { metadata: true } });
  const base = fresh?.metadata && typeof fresh.metadata === "object" && !Array.isArray(fresh.metadata) ? fresh.metadata : {};
  await db.socialAccount.update({
    where: { id: accountId },
    data: { metadata: { ...(base as Record<string, unknown>), instagramStats: state } as Prisma.InputJsonValue },
  });
}

/** Met à jour la liste des médias connus. Une erreur non fatale remonte (l'historique reste « incomplet »). */
async function syncMediaList(ctx: Ctx) {
  const { account, token, now } = ctx;
  const fullListing = !ctx.prev.historyComplete;
  const maxPages = fullListing ? FULL_LISTING_MAX_PAGES : NEXT_RUN_MAX_PAGES;
  const horizon = now.getTime() - NEXT_RUN_LISTING_DAYS * 86_400_000;

  // Médias publiés par Social Master : leur type est connu sans deviner (Reel, photo, carrousel, Story).
  const published = await db.postTarget.findMany({
    where: { platform: "INSTAGRAM", socialAccountId: account.id, platformPostId: { not: null } },
    select: { platformPostId: true, contentType: true },
  });
  const publishedAs = new Map(published.map((t) => [t.platformPostId!, t.contentType as string]));

  // Champs complets retentés à chaque passage (un refus d'un jour ne dégrade pas les suivants).
  let listFields: "full" | "fallback" = "full";
  let after: string | null = null;
  let listed = 0;
  let reachedEnd = false;
  let pages = 0;
  while (pages < maxPages) {
    if (Date.now() > ctx.deadline) break;
    let result: { items: ListedInstagramMedia[]; after: string | null };
    try {
      result = await listInstagramMediaPage(account.platformAccountId, token, {
        fields: listFields === "full" ? MEDIA_LIST_FIELDS : MEDIA_LIST_FIELDS_FALLBACK,
        after,
      });
    } catch (err) {
      const classified = classifyInsightsError(err);
      if (classified.kind === "token" || classified.kind === "permission") {
        throw new AbortAccount(classified.kind, classified.message, rawOf(err));
      }
      // Champ refusé (référence : media_product_type / caption réservés à Facebook Login) → repli sans eux.
      if (classified.kind === "invalid" && listFields === "full") {
        listFields = "fallback";
        continue;
      }
      throw err;
    }
    pages++;

    let oldest = Infinity;
    for (const item of result.items) {
      const postedAt = item.timestamp ? new Date(item.timestamp) : null;
      if (!postedAt || Number.isNaN(postedAt.getTime())) continue;
      oldest = Math.min(oldest, postedAt.getTime());
      const meta = {
        mediaType: item.media_type ?? null,
        mediaProductType: classifyListedMedia(item, publishedAs.get(item.id)),
        permalink: item.permalink ?? null,
        postedAt,
        // Légende absente en repli : on garde celle déjà connue.
        ...(item.caption !== undefined ? { caption: item.caption } : {}),
      };
      await db.instagramMedia.upsert({
        where: { socialAccountId_mediaId: { socialAccountId: account.id, mediaId: item.id } },
        create: { socialAccountId: account.id, mediaId: item.id, ...meta },
        update: meta,
      });
      listed++;
    }

    after = result.after;
    if (!after) {
      reachedEnd = true;
      break;
    }
    if (!fullListing && oldest < horizon) break;
  }
  // Historique complet : fin de la pagination atteinte, ou plafond des 2 000 médias les plus récents.
  const historyComplete = Boolean(ctx.prev.historyComplete) || (fullListing && (reachedEnd || pages >= maxPages));
  return { listed, listFields, historyComplete };
}

/**
 * Statistiques du compte jour par jour, du plus récent au plus ancien. Une réponse réussie confirme le droit
 * de lire les statistiques ; un refus de droit ici arrête le compte (c'est le vrai test du scope).
 */
async function refreshAccountDays(ctx: Ctx) {
  const { account, token, now } = ctx;
  const stored = await db.instagramAccountDay.findMany({ where: { socialAccountId: account.id }, select: { day: true } });
  const days = accountDaysToFetch(metaToday(now), new Set(stored.map((d) => d.day)));

  let updated = 0;
  let usedFallback = false;
  let consecutiveErrors = 0;
  let lastError: PhaseError | null = null;
  const result = (extra: { rateLimited?: boolean; outOfTime?: boolean; stopped?: boolean } = {}) => ({
    updated,
    usedFallback,
    error: lastError,
    ...extra,
  });

  for (const day of days) {
    if (Date.now() > ctx.deadline) return result({ outOfTime: true });
    const window = metaDayWindow(day);
    let totals: Record<string, number> | null = null;
    // Liste complète d'abord ; vues + portée seulement si la liste complète est refusée ET que le repli passe.
    for (const metrics of [ACCOUNT_DAY_METRICS, ACCOUNT_DAY_FALLBACK_METRICS]) {
      try {
        totals = parseAccountTotals(await fetchInstagramAccountTotals(account.platformAccountId, token, metrics, window));
        if (metrics === ACCOUNT_DAY_FALLBACK_METRICS) usedFallback = true;
        break;
      } catch (err) {
        const classified = classifyInsightsError(err);
        if (classified.kind === "token" || classified.kind === "permission") {
          throw new AbortAccount(classified.kind, classified.message, rawOf(err));
        }
        if (classified.kind === "rate_limited") return result({ rateLimited: true });
        lastError = { message: classified.message, raw: rawOf(err) };
        if (classified.kind !== "invalid") break;
      }
    }
    if (!totals) {
      if (++consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) return result({ stopped: true });
      continue;
    }
    consecutiveErrors = 0;
    const row = {
      views: "views" in totals ? Math.round(totals.views) : null,
      reach: "reach" in totals ? Math.round(totals.reach) : null,
      metrics: totals,
      fetchedAt: new Date(),
    };
    await db.instagramAccountDay.upsert({
      where: { socialAccountId_day: { socialAccountId: account.id, day } },
      create: { socialAccountId: account.id, day, ...row },
      update: row,
    });
    updated++;
  }
  return result();
}

/**
 * Statistiques des médias dont le relevé est dû. `accessConfirmed` = le droit a été prouvé au niveau du
 * compte : un refus de droit sur UN média (trop peu de vues, publié avant le passage en compte pro…) ne
 * concerne alors que ce média.
 */
async function refreshMediaStats(ctx: Ctx, accessConfirmed: boolean) {
  const { account, token, now } = ctx;
  const candidates = await db.instagramMedia.findMany({
    where: { socialAccountId: account.id, mediaProductType: { in: ["REELS", "FEED"] } },
    select: { id: true, mediaId: true, mediaProductType: true, postedAt: true, statsFetchedAt: true },
    orderBy: { postedAt: "desc" },
  });
  const due = candidates.filter((m) => statsRefreshDue(m, now));
  const batch = due.slice(0, MAX_MEDIA_PER_RUN);

  let updated = 0;
  let consecutiveErrors = 0;
  let lastError: PhaseError | null = null;
  const result = (extra: { rateLimited?: boolean; outOfTime?: boolean; stopped?: boolean } = {}) => ({
    updated,
    pending: due.length - updated,
    error: lastError,
    ...extra,
  });

  for (const media of batch) {
    if (Date.now() > ctx.deadline) return result({ outOfTime: true });
    const attempts = metricAttemptsFor(media.mediaProductType) ?? [];
    let refusal: string | null = null;
    let transient: PhaseError | null = null;
    for (const metrics of attempts) {
      try {
        const json = await fetchInstagramMediaInsights(media.mediaId, token, metrics);
        const { values, missing } = parseMediaInsights(json, metrics);
        if (Object.keys(values).length === 0) {
          // Jeu vide = « pas de donnée pour l'instant » selon Meta : rien n'est effacé, retenté au passage suivant.
          await db.instagramMedia.update({
            where: { id: media.id },
            data: { missingMetrics: missing, statsError: "Meta n'a renvoyé aucune donnée pour l'instant." },
          });
        } else {
          const fetchedAt = new Date();
          await db.instagramMedia.update({
            where: { id: media.id },
            data: { ...mediaStatsColumns(values), missingMetrics: missing, statsFetchedAt: fetchedAt, statsError: null },
          });
          await db.instagramMediaSnapshot.create({ data: { instagramMediaId: media.id, fetchedAt, metrics: values } });
          updated++;
        }
        refusal = null;
        consecutiveErrors = 0;
        break;
      } catch (err) {
        const classified = classifyInsightsError(err);
        if (classified.kind === "token" || (classified.kind === "permission" && !accessConfirmed)) {
          throw new AbortAccount(classified.kind, classified.message, rawOf(err));
        }
        if (classified.kind === "rate_limited") return result({ rateLimited: true });
        if (classified.kind === "invalid") {
          refusal = classified.message; // métrique refusée → liste suivante
          continue;
        }
        if (classified.kind === "permission") {
          refusal = "Instagram ne fournit pas de statistiques pour ce média.";
          break;
        }
        // Erreur passagère : rien n'est repoussé, le média sera retenté au passage suivant.
        transient = { message: classified.message, raw: rawOf(err) };
        break;
      }
    }
    if (refusal) {
      // Refus définitif pour ce média : noté et repoussé à sa cadence normale (pas de boucle d'erreurs).
      await db.instagramMedia.update({ where: { id: media.id }, data: { statsError: refusal, statsFetchedAt: new Date() } });
    }
    if (transient) {
      lastError = transient;
      await db.instagramMedia.update({ where: { id: media.id }, data: { statsError: transient.message } });
      if (++consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) return result({ stopped: true });
    }
  }
  return result();
}

async function logFailure(account: Account, kind: string, message: string, raw: string) {
  await db.activityLog.create({
    data: {
      userId: account.userId,
      entityType: "SocialAccount",
      entityId: account.id,
      action: "instagram_stats_failed",
      detail: { kind, message, rawError: raw },
    },
  });
}

async function collectForAccount(account: Account, now: Date, deadline: number): Promise<InstagramStatsState> {
  const prev = previousState(account.metadata);
  const state: InstagramStatsState = { lastRunAt: now.toISOString(), ok: true, historyComplete: prev.historyComplete ?? false };

  if (insightsScopeStatus(account.grantedScopes) === "missing") {
    return {
      ...state,
      ok: false,
      errorKind: "missing_scope",
      error: "Statistiques non autorisées : cliquez sur « Reconnecter » Instagram dans Connexions et acceptez les statistiques.",
    };
  }

  const ctx: Ctx = { account, token: decryptToken(account.accessTokenEnc), now, deadline, prev };
  // Premier problème rencontré = celui qu'on affiche ; l'erreur brute part dans le journal (§6.9).
  const fail = (kind: InstagramStatsState["errorKind"], error: string) => {
    state.ok = false;
    state.errorKind ??= kind;
    state.error ??= error;
  };
  const RATE_LIMITED = "Limite d'appels Instagram atteinte : relevé repris au passage suivant.";
  try {
    try {
      const list = await syncMediaList(ctx);
      state.mediaListed = list.listed;
      state.listFields = list.listFields;
      state.historyComplete = list.historyComplete;
    } catch (err) {
      if (err instanceof AbortAccount) throw err;
      // Liste illisible : on relève quand même les médias déjà connus ; l'historique sera repris au passage suivant.
      const classified = classifyInsightsError(err);
      fail(classified.kind, classified.message);
      await logFailure(account, "list", classified.message, rawOf(err));
    }

    const days = await refreshAccountDays(ctx);
    state.daysUpdated = days.updated;
    state.accountMetrics = days.usedFallback ? "fallback" : "full";
    if (days.rateLimited) {
      fail("rate_limited", RATE_LIMITED);
      return state;
    }
    if (days.stopped && days.error) {
      fail("other", `Statistiques du compte : ${days.error.message}`);
      await logFailure(account, "account_days", days.error.message, days.error.raw);
    }

    const media = await refreshMediaStats(ctx, days.updated > 0);
    state.mediaUpdated = media.updated;
    state.mediaPending = media.pending;
    if (media.rateLimited) fail("rate_limited", RATE_LIMITED);
    if (media.stopped && media.error) {
      fail("other", media.error.message);
      await logFailure(account, "media", media.error.message, media.error.raw);
    }
    if (days.outOfTime || media.outOfTime) fail("other", "Relevé trop long : la suite au passage suivant.");
    return state;
  } catch (err) {
    if (!(err instanceof AbortAccount)) throw err;
    await logFailure(account, err.kind, err.message, err.raw);
    return { ...state, ok: false, errorKind: err.kind, error: err.message };
  }
}

/**
 * Cron (sans `socialAccountId`) avec `enqueue` : un job par compte Instagram actif, dédoublonné par compte.
 * Avec un compte (ou sans `enqueue`, tests) : relevé direct.
 */
export async function runInstagramStats(
  data: InstagramStatsJobData = {},
  now = new Date(),
  enqueue?: (socialAccountId: string) => Promise<unknown>
) {
  const accounts = await db.socialAccount.findMany({
    where: { platform: "INSTAGRAM", status: "ACTIVE", ...(data.socialAccountId ? { id: data.socialAccountId } : {}) },
    select: { id: true, userId: true, platformAccountId: true, accessTokenEnc: true, grantedScopes: true, metadata: true },
  });
  if (!data.socialAccountId && enqueue) {
    for (const account of accounts) await enqueue(account.id);
    return [];
  }
  const deadline = Date.now() + RUN_BUDGET_MS;
  const reports: Array<{ socialAccountId: string } & InstagramStatsState> = [];
  for (const account of accounts) {
    let state: InstagramStatsState;
    try {
      state = await collectForAccount(account, now, deadline);
    } catch (err) {
      // Erreur inattendue (base, réseau) : notée, le compte suivant est relevé quand même.
      console.error("[instagram-stats]", err);
      state = { lastRunAt: now.toISOString(), ok: false, errorKind: "other", error: classifyInsightsError(err).message };
    }
    await saveState(account.id, state);
    reports.push({ socialAccountId: account.id, ...state });
  }
  return reports;
}
