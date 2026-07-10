import Link from "next/link";
import { formatInTimeZone } from "date-fns-tz";
import { getISOWeek, parseISO } from "date-fns";
import { fr } from "date-fns/locale";
import { SquarePen, Layers } from "lucide-react";
import { verifySession, getCurrentUser } from "@/lib/dal";
import { db } from "@/lib/db";
import { StatCard } from "@/components/ui/stat-card";
import { PageHeader } from "@/components/layout/page-header";
import { buttonVariants } from "@/components/ui/button";
import {
  UpcomingPostsCard,
  type UpcomingPost,
} from "@/components/dashboard/upcoming-posts-card";
import { WeekCalendarCard } from "@/components/dashboard/week-calendar-card";
import { ConnectionsCard } from "@/components/dashboard/connections-card";
import {
  NeedsAttentionCard,
  type ActionablePost,
  type PendingTikTokDraft,
} from "@/components/dashboard/needs-attention-card";
import { OnboardingCard } from "@/components/dashboard/onboarding-card";
import { AutoRefresh } from "@/components/util/auto-refresh";

/** Horaire effectif le plus tôt d'un post (min des PostTarget.scheduledAt, fallback Post.scheduledAt). */
function earliestTargetTime(
  post: { scheduledAt: Date | null; postTargets: { scheduledAt: Date | null }[] }
): Date | null {
  const earliest = post.postTargets.reduce<Date | null>((min, t) => {
    const effective = t.scheduledAt ?? post.scheduledAt;
    if (!effective) return min;
    return !min || effective < min ? effective : min;
  }, null);
  return earliest ?? post.scheduledAt;
}

/** Miniature réelle du premier média (position 0) : thumbnailKey d'une vidéo sinon storageKey d'une image. */
function firstThumbnailKey(
  postMedia: {
    position: number;
    mediaAsset: { storageKey: string; mimeType: string; thumbnailKey: string | null };
  }[]
): string | null {
  const first = [...postMedia].sort((a, b) => a.position - b.position)[0];
  if (!first) return null;
  const asset = first.mediaAsset;
  if (asset.mimeType.startsWith("video/")) return asset.thumbnailKey ?? null;
  return asset.storageKey;
}

export default async function DashboardPage() {
  const session = await verifySession();
  const user = await getCurrentUser();
  const timezone = user?.timezone ?? "Europe/Paris";

  const now = new Date();
  const in72h = new Date(now.getTime() + 72 * 3600 * 1000);
  const in30dAgo = new Date(now.getTime() - 30 * 24 * 3600 * 1000);
  const in7dAgo = new Date(now.getTime() - 7 * 24 * 3600 * 1000);

  // Repères de calendrier dans le fuseau du user (jour/semaine « locaux »).
  const dayKey = (d: Date) => formatInTimeZone(d, timezone, "yyyy-MM-dd");
  const todayKey = dayKey(now);
  // Lundi de la semaine locale courante : jour de la semaine ISO (1=lundi … 7=dimanche).
  // Ancré sur la DATE CIVILE locale (todayKey) convertie en minuit UTC, puis recul de (isoDow-1)
  // jours UTC (toujours 24 h) : robuste aux bascules d'heure d'été (soustraire des multiples plats
  // de 24 h à l'instant absolu `now` pouvait faire basculer la date à ±1 h de minuit un jour de DST).
  const isoDow = Number(formatInTimeZone(now, timezone, "i"));
  const mondayKey = formatInTimeZone(
    new Date(parseISO(`${todayKey}T00:00:00Z`).getTime() - (isoDow - 1) * 24 * 3600 * 1000),
    "UTC",
    "yyyy-MM-dd"
  );
  const mediaInclude = {
    postMedia: {
      include: { mediaAsset: { select: { storageKey: true, mimeType: true, thumbnailKey: true } } },
    },
    postTargets: true,
  } as const;

  // Requêtes SÉQUENTIELLES : le moteur `prisma dev` local ferme la connexion (P1017) sous
  // requêtes concurrentes avec includes imbriqués (cf. CLAUDE.md §15) ; en prod le coût est
  // de quelques ms sur des requêtes de cette taille.
  // Posts programmés à venir (fenêtre large : on filtre les 72 h ensuite via l'horaire
  // effectif par cible, qui peut différer de Post.scheduledAt).
  const scheduledPosts = await db.post.findMany({
    where: { userId: session.userId, status: "SCHEDULED", scheduledAt: { gte: now } },
    include: mediaInclude,
    orderBy: { scheduledAt: "asc" },
    take: 60,
  });
  // Publiés des 30 derniers jours (updatedAt = horodatage de passage à PUBLISHED pour ce projet).
  const recentPublished = await db.post.findMany({
    where: { userId: session.userId, status: "PUBLISHED", updatedAt: { gte: in30dAgo } },
    select: { id: true, updatedAt: true },
  });
  const failuresCount = await db.post.count({
    where: {
      userId: session.userId,
      status: { in: ["FAILED", "PARTIALLY_PUBLISHED"] },
    },
  });
  const publishedCount30d = recentPublished.length;
  // Carte « À traiter » (P2-2 + P1-5c) : échecs/succès partiels — requête distincte de `failuresCount`
  // (non plafonné) puisqu'on ne veut afficher ici que les N plus récents, pas la liste exhaustive.
  const actionablePosts = await db.post.findMany({
    where: {
      userId: session.userId,
      status: { in: ["FAILED", "PARTIALLY_PUBLISHED"] },
    },
    select: {
      id: true,
      caption: true,
      status: true,
      postTargets: { select: { errorMessage: true } },
    },
    orderBy: { updatedAt: "desc" },
    take: 5,
  });
  // Cibles TikTok en mode brouillon arrivées dans l'inbox (finalisation manuelle requise), 7 j.
  const pendingTiktokDrafts = await db.postTarget.findMany({
    where: {
      post: { userId: session.userId },
      platform: "TIKTOK",
      publishMode: "TIKTOK_DRAFT",
      status: "SENT_TO_INBOX",
      updatedAt: { gte: in7dAgo },
    },
    select: {
      id: true,
      postId: true,
      captionOverride: true,
      post: { select: { caption: true, hashtags: true } },
    },
    orderBy: { updatedAt: "desc" },
    take: 5,
  });
  const accounts = await db.socialAccount.findMany({
    where: { userId: session.userId },
    select: { id: true, platform: true, username: true, status: true },
    orderBy: { createdAt: "asc" },
  });

  // ——— Stat 1 : programmées (72 h) ———
  const scheduledWithTime = scheduledPosts
    .map((post) => ({ post, at: earliestTargetTime(post) }))
    .filter((x): x is { post: (typeof scheduledPosts)[number]; at: Date } => x.at != null);
  const in72hPosts = scheduledWithTime.filter((x) => x.at <= in72h);
  const scheduledTodayCount = in72hPosts.filter((x) => dayKey(x.at) === todayKey).length;

  // ——— Stat 2 : publiées (30 j) ———
  const publishedThisWeek = recentPublished.filter((p) => dayKey(p.updatedAt) >= mondayKey).length;

  // ——— Liste « Prochaines publications » : UNIQUEMENT des posts programmés à venir (P2-2) ———
  // Plus aucun post passé (publié/échoué/brouillon) n'y est mélangé — voir NeedsAttentionCard
  // ci-dessous pour les échecs et brouillons TikTok en attente.
  const upcomingSorted = [...scheduledWithTime].sort((a, b) => a.at.getTime() - b.at.getTime());
  const listPosts = upcomingSorted.map((x) => x.post).slice(0, 6);

  const upcomingCards: UpcomingPost[] = listPosts.map((post) => ({
    id: post.id,
    caption: post.caption,
    status: post.status,
    thumbnailKey: firstThumbnailKey(post.postMedia),
    targets: post.postTargets.map((t) => ({
      id: t.id,
      platform: t.platform,
      scheduledAt: t.scheduledAt ?? post.scheduledAt,
    })),
  }));

  // ——— Carte « À traiter » : échecs/succès partiels + brouillons TikTok en attente ———
  const actionablePostCards: ActionablePost[] = actionablePosts.map((post) => ({
    id: post.id,
    caption: post.caption,
    status: post.status,
    errorMessage: post.postTargets.find((t) => t.errorMessage != null)?.errorMessage ?? null,
  }));
  const tiktokDraftCards: PendingTikTokDraft[] = pendingTiktokDrafts.map((target) => ({
    targetId: target.id,
    postId: target.postId,
    caption: target.post.caption,
    hashtags: target.post.hashtags,
    captionOverride: target.captionOverride,
  }));

  // ——— Mini-calendrier : semaine locale courante + pips des jours ayant ≥1 post programmé ———
  // Les jours sont construits à minuit UTC à partir de la date locale (yyyy-MM-dd) puis affichés en
  // UTC, de sorte que le numéro affiché soit exactement le jour calendaire local, sans décalage.
  const weekDays = Array.from({ length: 7 }, (_, i) => {
    const base = parseISO(`${mondayKey}T00:00:00Z`);
    return new Date(base.getTime() + i * 24 * 3600 * 1000);
  });
  const scheduledDayKeys = new Set(scheduledWithTime.map((x) => dayKey(x.at)));
  const monthLabel = formatInTimeZone(now, timezone, "MMMM yyyy", { locale: fr });
  const weekNumber = getISOWeek(parseISO(`${todayKey}T00:00:00Z`));

  return (
    <div className="space-y-4">
      <AutoRefresh intervalMs={60000} />
      <PageHeader
        title={`Bonjour${user?.name ? `, ${user.name}` : ""} 👋`}
        description="Voici l’état de votre planificateur."
        actions={
          <>
            <Link href="/composer/bulk" className={buttonVariants({ variant: "outline" })}>
              <Layers className="size-4" />
              Publication en masse
            </Link>
            <Link href="/composer" className={buttonVariants({ variant: "default" })}>
              <SquarePen className="size-4" />
              Créer un post
            </Link>
          </>
        }
      />

      {accounts.length === 0 && <OnboardingCard />}

      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard
          label="Programmées (72 h)"
          value={in72hPosts.length}
          delta={`${scheduledTodayCount} aujourd’hui`}
          deltaTone="accent"
        />
        <StatCard
          label="Publiées (30 j)"
          value={publishedCount30d}
          delta={`+${publishedThisWeek} cette semaine`}
          deltaTone="accent"
        />
        {failuresCount > 0 ? (
          <Link
            href="/history?filter=failed"
            className="group block rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <StatCard
              label="Échecs à corriger"
              value={failuresCount}
              delta="À corriger en priorité"
              deltaTone="err"
              className="transition-colors group-hover:border-destructive/40"
            />
          </Link>
        ) : (
          <StatCard
            label="Échecs à corriger"
            value={failuresCount}
            delta="Tout est en ordre"
            deltaTone="ok"
          />
        )}
      </div>

      <div className="grid items-start gap-3 lg:grid-cols-[1.45fr_1fr]">
        <div className="flex flex-col gap-3">
          <UpcomingPostsCard posts={upcomingCards} now={now} timezone={timezone} />
          <NeedsAttentionCard failedPosts={actionablePostCards} tiktokDrafts={tiktokDraftCards} />
        </div>
        <div className="flex flex-col gap-3">
          <WeekCalendarCard
            weekDays={weekDays}
            monthLabel={monthLabel}
            weekNumber={weekNumber}
            todayKey={todayKey}
            scheduledDayKeys={scheduledDayKeys}
          />
          <ConnectionsCard accounts={accounts} />
        </div>
      </div>
    </div>
  );
}
