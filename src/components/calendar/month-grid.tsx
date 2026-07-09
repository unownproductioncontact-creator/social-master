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

const PLATFORM_LABELS: Record<string, string> = {
  INSTAGRAM: "Instagram",
  TIKTOK: "TikTok",
};

type CalendarTarget = {
  id: string;
  platform: string;
  scheduledAt: Date;
};

type CalendarPost = {
  id: string;
  caption: string;
  status: string;
  scheduledAt: Date;
  targets: CalendarTarget[];
};

// Horaire le plus tôt et le plus tard parmi les cibles d'un post (fallback sur Post.scheduledAt
// si le post n'a aucune cible, cas théorique seulement).
function targetSpan(post: CalendarPost): { earliest: Date; latest: Date } {
  if (post.targets.length === 0) return { earliest: post.scheduledAt, latest: post.scheduledAt };
  const times = post.targets.map((t) => t.scheduledAt.getTime());
  return { earliest: new Date(Math.min(...times)), latest: new Date(Math.max(...times)) };
}

// Libellé compact de l'horaire à afficher sur un chip de post : une heure unique si toutes les
// cibles partagent le même horaire (à la minute près), sinon chaque horaire par cible séparé par "/"
// (ex. "18:00/18:05" pour TikTok à H et Instagram à H+5min).
function formatTimeLabel(post: CalendarPost): string {
  if (post.targets.length === 0) return format(post.scheduledAt, "HH:mm");
  const uniqueTimes = Array.from(new Set(post.targets.map((t) => format(t.scheduledAt, "HH:mm"))));
  return uniqueTimes.sort().join("/");
}

// Détail complet "Plateforme · HH:mm" par cible, pour le tooltip et la vue agenda mobile.
function targetDetails(post: CalendarPost): string[] {
  return post.targets.map(
    (t) => `${PLATFORM_LABELS[t.platform] ?? t.platform} · ${format(t.scheduledAt, "HH:mm")}`
  );
}

export function MonthGrid({ month, posts }: { month: Date; posts: CalendarPost[] }) {
  const monthStart = startOfMonth(month);
  const monthEnd = endOfMonth(month);
  const gridStart = startOfWeek(monthStart, { weekStartsOn: 1 });
  const gridEnd = endOfWeek(monthEnd, { weekStartsOn: 1 });
  const days = eachDayOfInterval({ start: gridStart, end: gridEnd });

  // Regroupement par jour : un post apparaît sur CHAQUE jour où au moins une de ses cibles est
  // programmée (cas rare mais réel : cibles à cheval sur minuit, ex. 23:58 + 00:03).
  const postsByDay = new Map<string, CalendarPost[]>();
  for (const post of posts) {
    const { earliest, latest } = targetSpan(post);
    const dayKeys = new Set([format(earliest, "yyyy-MM-dd"), format(latest, "yyyy-MM-dd")]);
    for (const key of dayKeys) {
      const existing = postsByDay.get(key) ?? [];
      existing.push(post);
      postsByDay.set(key, existing);
    }
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
                    <Link key={post.id} href={`/composer/${post.id}`} className="block">
                      <Badge
                        variant={STATUS_VARIANT[post.status] ?? "outline"}
                        title={targetDetails(post).join(" · ")}
                        className="block w-full truncate text-left font-normal"
                      >
                        <span className="tabular-nums">{formatTimeLabel(post)}</span> ·{" "}
                        {post.caption || "(sans légende)"}
                      </Badge>
                      {post.targets.length > 1 && (
                        <p className="mt-0.5 truncate pl-1 text-[11px] text-muted-foreground">
                          {targetDetails(post).join(" · ")}
                        </p>
                      )}
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
                        title={targetDetails(post).join(" · ")}
                        className="block w-full truncate text-left font-normal"
                      >
                        <span className="tabular-nums">{formatTimeLabel(post)}</span> ·{" "}
                        {post.caption || "(sans légende)"}
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
