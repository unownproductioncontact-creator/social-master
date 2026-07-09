import Link from "next/link";
import { addMonths, addDays, startOfMonth, endOfMonth, format, parse, isValid } from "date-fns";
import { fr } from "date-fns/locale";
import { verifySession, getCurrentUser } from "@/lib/dal";
import { db } from "@/lib/db";
import { MonthGrid } from "@/components/calendar/month-grid";
import { buttonVariants } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/layout/page-header";
import { ChevronLeft, ChevronRight, CalendarDays } from "lucide-react";

function parseMonthParam(month: string | undefined): Date {
  if (!month) return new Date();
  const parsed = parse(month, "yyyy-MM", new Date());
  return isValid(parsed) ? parsed : new Date();
}

export default async function CalendarPage(props: PageProps<"/calendar">) {
  const session = await verifySession();
  const user = await getCurrentUser();
  const timezone = user?.timezone ?? "Europe/Paris";
  const searchParams = await props.searchParams;
  const monthParam = Array.isArray(searchParams.month) ? searchParams.month[0] : searchParams.month;
  const month = parseMonthParam(monthParam);

  const rangeStart = startOfMonth(month);
  const rangeEnd = endOfMonth(month);

  // Post.scheduledAt (référence de tri/filtre) reste la borne de requête, mais une cible individuelle
  // peut légèrement déborder sur le jour suivant/précédent (ex. 23:58 + 00:03) — on élargit donc d'1
  // jour de chaque côté pour ne pas manquer un post dont le Post.scheduledAt est hors mois affiché de
  // justesse à cause de ce décalage, puis MonthGrid n'affichera de toute façon que les jours du mois.
  const posts = await db.post.findMany({
    where: {
      userId: session.userId,
      scheduledAt: { gte: addDays(rangeStart, -1), lte: addDays(rangeEnd, 1) },
      status: { not: "DRAFT" },
    },
    include: { postTargets: true },
    orderBy: { scheduledAt: "asc" },
  });

  const calendarPosts = posts
    .filter((p) => p.scheduledAt != null)
    .map((p) => ({
      id: p.id,
      caption: p.caption,
      status: p.status,
      scheduledAt: p.scheduledAt!,
      targets: p.postTargets.map((t) => ({
        id: t.id,
        platform: t.platform,
        scheduledAt: t.scheduledAt ?? p.scheduledAt!,
      })),
    }));

  const prevMonth = format(addMonths(month, -1), "yyyy-MM");
  const nextMonth = format(addMonths(month, 1), "yyyy-MM");

  return (
    <div className="space-y-6">
      <PageHeader
        title="Calendrier"
        description="Vue mensuelle de vos publications programmées."
        actions={
          <>
            <Link href={`/calendar?month=${prevMonth}`} className={buttonVariants({ variant: "outline", size: "icon-sm" })}>
              <ChevronLeft className="size-4" />
            </Link>
            <span className="w-28 text-center text-[13.5px] font-semibold capitalize">
              {format(month, "MMMM yyyy", { locale: fr })}
            </span>
            <Link href={`/calendar?month=${nextMonth}`} className={buttonVariants({ variant: "outline", size: "icon-sm" })}>
              <ChevronRight className="size-4" />
            </Link>
          </>
        }
      />

      <MonthGrid month={month} posts={calendarPosts} timezone={timezone} />

      {calendarPosts.length === 0 && (
        <EmptyState
          icon={CalendarDays}
          title="Aucune publication programmée ce mois-ci"
          description="Créez un post et programmez-le depuis le composer."
        />
      )}
    </div>
  );
}
