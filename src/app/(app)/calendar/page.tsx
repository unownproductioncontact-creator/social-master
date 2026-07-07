import Link from "next/link";
import { addMonths, startOfMonth, endOfMonth, format, parse, isValid } from "date-fns";
import { fr } from "date-fns/locale";
import { verifySession } from "@/lib/dal";
import { db } from "@/lib/db";
import { MonthGrid } from "@/components/calendar/month-grid";
import { buttonVariants } from "@/components/ui/button";
import { ChevronLeft, ChevronRight } from "lucide-react";

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
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Calendrier</h1>
          <p className="text-muted-foreground">Vue mensuelle de vos publications programmées.</p>
        </div>
        <div className="flex items-center gap-2">
          <Link href={`/calendar?month=${prevMonth}`} className={buttonVariants({ variant: "outline", size: "icon" })}>
            <ChevronLeft className="size-4" />
          </Link>
          <span className="w-32 text-center text-sm font-medium capitalize">
            {format(month, "MMMM yyyy", { locale: fr })}
          </span>
          <Link href={`/calendar?month=${nextMonth}`} className={buttonVariants({ variant: "outline", size: "icon" })}>
            <ChevronRight className="size-4" />
          </Link>
        </div>
      </div>

      <MonthGrid month={month} posts={calendarPosts} />

      {calendarPosts.length === 0 && (
        <p className="text-sm text-muted-foreground">
          Aucune publication programmée ce mois-ci. Créez un post et programmez-le depuis le composer.
        </p>
      )}
    </div>
  );
}
