import Link from "next/link";
import { formatInTimeZone } from "date-fns-tz";
import { getISOWeek, parseISO } from "date-fns";
import { fr } from "date-fns/locale";
import { LibraryBig, Plus } from "lucide-react";
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

  // Repères de calendrier dans le fuseau du user (jour/semaine « locaux »).
  const dayKey = (d: Date) => formatInTimeZone(d, timezone, "yyyy-MM-dd");
  const todayKey = dayKey(now);
  // Lundi de la semaine locale courante : jour de la semaine ISO (1=lundi … 7=dimanche).
  const isoDow = Number(formatInTimeZone(now, timezone, "i"));
  const mondayKey = dayKey(new Date(now.getTime() - (isoDow - 1) * 24 * 3600 * 1000));
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
  // Posts récents non-programmés (pour compléter la liste jusqu'à 6, comme la maquette qui mélange).
  const recentOtherPosts = await db.post.findMany({
    where: {
      userId: session.userId,
      status: { in: ["PUBLISHED", "PARTIALLY_PUBLISHED", "FAILED", "DRAFT"] },
    },
    include: mediaInclude,
    orderBy: { updatedAt: "desc" },
    take: 6,
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

  // ——— Liste « Prochaines publications » : programmés à venir d'abord, puis récents pour remplir ———
  const upcomingSorted = [...scheduledWithTime].sort((a, b) => a.at.getTime() - b.at.getTime());
  const usedIds = new Set(upcomingSorted.map((x) => x.post.id));
  const fillers = recentOtherPosts.filter((p) => !usedIds.has(p.id));
  const listPosts = [...upcomingSorted.map((x) => x.post), ...fillers].slice(0, 6);

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
      <PageHeader
        title={`Bonjour${user?.name ? `, ${user.name}` : ""} 👋`}
        description="Voici l’état de votre planificateur."
        actions={
          <>
            <Link href="/library" className={buttonVariants({ variant: "outline" })}>
              <LibraryBig className="size-4" />
              Médiathèque
            </Link>
            <Link href="/composer" className={buttonVariants({ variant: "default" })}>
              <Plus className="size-4" />
              Nouveau post
            </Link>
          </>
        }
      />

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
        <StatCard
          label="Échecs à corriger"
          value={failuresCount}
          delta={failuresCount === 0 ? "Tout est en ordre" : "À corriger en priorité"}
          deltaTone={failuresCount === 0 ? "ok" : "err"}
        />
      </div>

      <div className="grid items-start gap-3 lg:grid-cols-[1.45fr_1fr]">
        <UpcomingPostsCard posts={upcomingCards} now={now} timezone={timezone} />
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
