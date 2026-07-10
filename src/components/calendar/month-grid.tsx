import Link from "next/link";
import {
  startOfMonth,
  endOfMonth,
  startOfWeek,
  endOfWeek,
  eachDayOfInterval,
  isSameMonth,
  format,
} from "date-fns";
import { formatInTimeZone } from "date-fns-tz";
import { fr } from "date-fns/locale";
import { Plus } from "lucide-react";
import { StatusBadge, postStatusTone, postStatusLabel } from "@/components/ui/status-badge";
import { PlatformChip, platformLabel } from "@/components/ui/platform-chip";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const WEEKDAY_LABELS = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];

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
function formatTimeLabel(post: CalendarPost, timezone: string): string {
  if (post.targets.length === 0)
    return formatInTimeZone(post.scheduledAt, timezone, "HH:mm");
  const uniqueTimes = Array.from(
    new Set(post.targets.map((t) => formatInTimeZone(t.scheduledAt, timezone, "HH:mm")))
  );
  return uniqueTimes.sort().join("/");
}

// Détail complet "Plateforme · HH:mm" par cible, pour le tooltip et la vue agenda mobile.
function targetDetails(post: CalendarPost, timezone: string): string[] {
  return post.targets.map(
    (t) => `${platformLabel(t.platform)} · ${formatInTimeZone(t.scheduledAt, timezone, "HH:mm")}`
  );
}

// Classes du petit lien "+" de création rapide, partagées entre la grille desktop (masqué sauf
// survol) et l'agenda mobile (toujours visible, pas de survol tactile).
function createLinkClassName(alwaysVisible: boolean): string {
  return cn(
    buttonVariants({ variant: "ghost", size: "icon-xs" }),
    "shrink-0 text-muted-foreground",
    !alwaysVisible && "opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
  );
}

export function MonthGrid({
  month,
  posts,
  timezone,
}: {
  month: Date;
  posts: CalendarPost[];
  timezone: string;
}) {
  const monthStart = startOfMonth(month);
  const monthEnd = endOfMonth(month);
  const gridStart = startOfWeek(monthStart, { weekStartsOn: 1 });
  const gridEnd = endOfWeek(monthEnd, { weekStartsOn: 1 });
  const days = eachDayOfInterval({ start: gridStart, end: gridEnd });

  // Regroupement par jour : un post apparaît sur CHAQUE jour où au moins une de ses cibles est
  // programmée (cas rare mais réel : cibles à cheval sur minuit, ex. 23:58 + 00:03).
  // « Aujourd'hui » dans le fuseau du user (le fuseau du process est UTC en prod).
  const todayKey = formatInTimeZone(new Date(), timezone, "yyyy-MM-dd");
  const postsByDay = new Map<string, CalendarPost[]>();
  for (const post of posts) {
    const { earliest, latest } = targetSpan(post);
    const dayKeys = new Set([
      formatInTimeZone(earliest, timezone, "yyyy-MM-dd"),
      formatInTimeZone(latest, timezone, "yyyy-MM-dd"),
    ]);
    for (const key of dayKeys) {
      const existing = postsByDay.get(key) ?? [];
      existing.push(post);
      postsByDay.set(key, existing);
    }
  }

  // Sous md : vue agenda verticale. Un jour du mois y apparaît s'il a des posts, ou s'il reste
  // créable (non passé, aujourd'hui inclus) pour y exposer le "+" de création rapide (P3-6c).
  const agendaDays = days
    .filter((day) => isSameMonth(day, month))
    .map((day) => ({ day, key: format(day, "yyyy-MM-dd") }))
    .filter(({ key }) => (postsByDay.get(key) ?? []).length > 0 || key >= todayKey);

  return (
    <>
      <div className="space-y-3 md:hidden">
        {agendaDays.length === 0 ? (
          <p className="rounded-lg border border-border p-4 text-[13.5px] text-muted-foreground">
            Aucune publication programmée ce mois-ci.
          </p>
        ) : (
          agendaDays.map(({ day, key }) => {
            const dayPosts = postsByDay.get(key) ?? [];
            const canCreate = key >= todayKey;
            return (
              <div key={key} className="overflow-hidden rounded-lg border border-border bg-card">
                <div className="flex items-center gap-2 border-b border-border px-3.5 py-2.5 text-[13.5px] font-semibold">
                  <span
                    className={cn(
                      "inline-flex size-6 shrink-0 items-center justify-center rounded-lg text-xs tabular-nums",
                      key === todayKey && "bg-primary-strong font-bold text-primary-foreground"
                    )}
                  >
                    {format(day, "d")}
                  </span>
                  <span className="capitalize">{format(day, "EEEE d MMMM", { locale: fr })}</span>
                  {canCreate && (
                    <Link
                      href={`/composer?date=${key}`}
                      aria-label={`Créer un post le ${format(day, "d MMMM yyyy", { locale: fr })}`}
                      className={cn(createLinkClassName(true), "ml-auto")}
                    >
                      <Plus className="size-3.5" />
                    </Link>
                  )}
                </div>
                {dayPosts.length > 0 && (
                  <div className="space-y-1.5 p-2.5">
                    {dayPosts.map((post) => {
                      const isFailed = post.status === "FAILED";
                      return (
                        <Link
                          key={post.id}
                          href={`/composer/${post.id}`}
                          className="block rounded-md border border-border p-2 text-[13px] hover:bg-muted/50"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="truncate font-medium">
                              {isFailed && (
                                <span
                                  aria-hidden="true"
                                  className="mr-1.5 inline-block size-[5px] rounded-full bg-destructive align-middle"
                                />
                              )}
                              {post.caption || "(sans légende)"}
                            </span>
                            <StatusBadge tone={postStatusTone(post.status)} className="shrink-0">
                              {postStatusLabel(post.status)}
                            </StatusBadge>
                          </div>
                          <div className="mt-1.5 flex flex-wrap gap-1">
                            {post.targets.map((target) => (
                              <PlatformChip
                                key={target.id}
                                platform={target.platform}
                                time={formatInTimeZone(target.scheduledAt, timezone, "HH:mm")}
                              />
                            ))}
                            {post.targets.length === 0 && (
                              <span className="tabular-nums text-[11.5px] text-muted-foreground">
                                {formatTimeLabel(post, timezone)}
                              </span>
                            )}
                          </div>
                        </Link>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      <div className="hidden overflow-hidden rounded-lg border border-border bg-card md:block">
        <div className="grid grid-cols-7 border-b border-border text-[10px] font-semibold tracking-[0.05em] text-muted-foreground uppercase">
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
            const inMonth = isSameMonth(day, month);
            const canCreate = inMonth && key >= todayKey;
            return (
              <div
                key={key}
                className={cn(
                  "group min-h-24 border-b border-r border-border p-1.5 last:border-r-0",
                  !inMonth && "bg-muted/30 text-muted-foreground"
                )}
              >
                <div className="mb-1 flex items-center justify-between gap-1">
                  <span
                    className={cn(
                      "inline-flex size-6 items-center justify-center rounded-lg text-xs tabular-nums text-muted-foreground",
                      !inMonth && "opacity-50",
                      key === todayKey && "bg-primary-strong font-bold text-primary-foreground opacity-100"
                    )}
                  >
                    {format(day, "d")}
                  </span>
                  {canCreate && (
                    <Link
                      href={`/composer?date=${key}`}
                      aria-label={`Créer un post le ${format(day, "d MMMM yyyy", { locale: fr })}`}
                      className={createLinkClassName(false)}
                    >
                      <Plus className="size-3.5" />
                    </Link>
                  )}
                </div>
                <div className="space-y-1">
                  {dayPosts.map((post) => {
                    const isFailed = post.status === "FAILED";
                    const singleTarget = post.targets.length === 1 ? post.targets[0] : null;
                    return (
                      <Link
                        key={post.id}
                        href={`/composer/${post.id}`}
                        title={targetDetails(post, timezone).join(" · ")}
                        className="block"
                      >
                        {singleTarget ? (
                          <PlatformChip
                            platform={singleTarget.platform}
                            time={formatInTimeZone(singleTarget.scheduledAt, timezone, "HH:mm")}
                            className={cn(
                              "w-full justify-start truncate",
                              isFailed && "border-destructive/40 text-destructive"
                            )}
                          />
                        ) : (
                          <span className="flex w-full items-center gap-1 truncate rounded-full border border-input bg-secondary px-2 py-[2.5px] text-[11px] font-semibold text-secondary-foreground">
                            <span
                              aria-hidden="true"
                              className={cn(
                                "size-[5px] shrink-0 rounded-full",
                                isFailed ? "bg-destructive" : "bg-primary-strong"
                              )}
                            />
                            <span className="truncate">
                              {post.targets.length > 0 ? (
                                <span className="tabular-nums font-bold">{formatTimeLabel(post, timezone)}</span>
                              ) : null}{" "}
                              {post.caption || "(sans légende)"}
                            </span>
                          </span>
                        )}
                      </Link>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
