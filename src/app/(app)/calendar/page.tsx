import Link from "next/link";
import { addMonths, startOfMonth, endOfMonth, format, parse, isValid } from "date-fns";
import { fr } from "date-fns/locale";
import { verifySession } from "@/lib/dal";
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
  const searchParams = await props.searchParams;
  const monthParam = Array.isArray(searchParams.month) ? searchParams.month[0] : searchParams.month;
  const month = parseMonthParam(monthParam);

  const rangeStart = startOfMonth(month);
  const rangeEnd = endOfMonth(month);

  const posts = await db.post.findMany({
    where: {
      userId: session.userId,
      scheduledAt: { gte: rangeStart, lte: rangeEnd },
      status: { not: "DRAFT" },
    },
    orderBy: { scheduledAt: "asc" },
  });

  const calendarPosts = posts
    .filter((p) => p.scheduledAt != null)
    .map((p) => ({ id: p.id, caption: p.caption, status: p.status, scheduledAt: p.scheduledAt! }));

  const prevMonth = format(addMonths(month, -1), "yyyy-MM");
  const nextMonth = format(addMonths(month, 1), "yyyy-MM");

  return (
    <div className="space-y-6">
      <PageHeader
        title="Calendrier"
        description="Vue mensuelle de vos publications programmées."
        actions={
          <>
            <Link href={`/calendar?month=${prevMonth}`} className={buttonVariants({ variant: "outline", size: "icon" })}>
              <ChevronLeft className="size-4" />
            </Link>
            <span className="w-32 text-center text-sm font-medium capitalize">
              {format(month, "MMMM yyyy", { locale: fr })}
            </span>
            <Link href={`/calendar?month=${nextMonth}`} className={buttonVariants({ variant: "outline", size: "icon" })}>
              <ChevronRight className="size-4" />
            </Link>
          </>
        }
      />

      <MonthGrid month={month} posts={calendarPosts} />

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
