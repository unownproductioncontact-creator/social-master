import Link from "next/link";
import {
  startOfMonth,
  endOfMonth,
  startOfWeek,
  endOfWeek,
  eachDayOfInterval,
  isSameMonth,
  isToday,
  format,
} from "date-fns";
import { fr } from "date-fns/locale";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const WEEKDAY_LABELS = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  SCHEDULED: "default",
  PUBLISHED: "secondary",
  PARTIALLY_PUBLISHED: "outline",
  FAILED: "destructive",
};

type CalendarPost = {
  id: string;
  caption: string;
  status: string;
  scheduledAt: Date;
};

export function MonthGrid({ month, posts }: { month: Date; posts: CalendarPost[] }) {
  const monthStart = startOfMonth(month);
  const monthEnd = endOfMonth(month);
  const gridStart = startOfWeek(monthStart, { weekStartsOn: 1 });
  const gridEnd = endOfWeek(monthEnd, { weekStartsOn: 1 });
  const days = eachDayOfInterval({ start: gridStart, end: gridEnd });

  const postsByDay = new Map<string, CalendarPost[]>();
  for (const post of posts) {
    const key = format(post.scheduledAt, "yyyy-MM-dd");
    const existing = postsByDay.get(key) ?? [];
    existing.push(post);
    postsByDay.set(key, existing);
  }

  // Sous md : vue agenda verticale, seulement les jours du mois ayant des posts.
  const agendaDays = days
    .filter((day) => isSameMonth(day, month))
    .map((day) => ({ day, key: format(day, "yyyy-MM-dd") }))
    .filter(({ key }) => (postsByDay.get(key) ?? []).length > 0);

  return (
    <>
      <div className="space-y-3 md:hidden">
        {agendaDays.length === 0 ? (
          <p className="rounded-lg border p-4 text-sm text-muted-foreground">
            Aucune publication programmée ce mois-ci.
          </p>
        ) : (
          agendaDays.map(({ day, key }) => {
            const dayPosts = postsByDay.get(key) ?? [];
            return (
              <div key={key} className="overflow-hidden rounded-lg border">
                <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-2 text-sm font-medium">
                  <span
                    className={cn(
                      "inline-flex size-6 shrink-0 items-center justify-center rounded-full text-xs",
                      isToday(day) && "bg-foreground text-background"
                    )}
                  >
                    {format(day, "d")}
                  </span>
                  <span className="capitalize">{format(day, "EEEE d MMMM", { locale: fr })}</span>
                </div>
                <div className="space-y-1 p-2">
                  {dayPosts.map((post) => (
                    <Link key={post.id} href={`/composer/${post.id}`}>
                      <Badge
                        variant={STATUS_VARIANT[post.status] ?? "outline"}
                        className="block w-full truncate text-left font-normal"
                      >
                        {format(post.scheduledAt, "HH:mm")} · {post.caption || "(sans légende)"}
                      </Badge>
                    </Link>
                  ))}
                </div>
              </div>
            );
          })
        )}
      </div>

      <div className="hidden overflow-hidden rounded-lg border md:block">
        <div className="grid grid-cols-7 border-b bg-muted/40 text-xs font-medium text-muted-foreground">
          {WEEKDAY_LABELS.map((label) => (
            <div key={label} className="px-2 py-2">
              {label}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {days.map((day) => {
            const key = format(day, "yyyy-MM-dd");
            const dayPosts = postsByDay.get(key) ?? [];
            return (
              <div
                key={key}
                className={cn(
                  "min-h-28 border-b border-r p-2 last:border-r-0",
                  !isSameMonth(day, month) && "bg-muted/20 text-muted-foreground"
                )}
              >
                <div
                  className={cn(
                    "mb-1 inline-flex size-6 items-center justify-center rounded-full text-xs",
                    isToday(day) && "bg-foreground text-background"
                  )}
                >
                  {format(day, "d")}
                </div>
                <div className="space-y-1">
                  {dayPosts.map((post) => (
                    <Link key={post.id} href={`/composer/${post.id}`}>
                      <Badge
                        variant={STATUS_VARIANT[post.status] ?? "outline"}
                        className="block w-full truncate text-left font-normal"
                      >
                        {format(post.scheduledAt, "HH:mm")} · {post.caption || "(sans légende)"}
                      </Badge>
                    </Link>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
