import Link from "next/link";
import { formatInTimeZone } from "date-fns-tz";
import { fr } from "date-fns/locale";
import { BarChart3, AlertTriangle } from "lucide-react";
import { verifySession, getCurrentUser } from "@/lib/dal";
import { getInstagramStatsForUser } from "@/lib/instagram-stats-service";
import { RECONNECT_FOR_STATS_MESSAGE } from "@/lib/instagram-stats";
import { PageHeader } from "@/components/layout/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { StatCard } from "@/components/ui/stat-card";
import { Card } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { statNumber, statPercent, statSeconds } from "@/components/stats/instagram-media-stats";
import { cn } from "@/lib/utils";

/**
 * Statistiques Instagram (CLAUDE.md §43) : lecture de ce que le relevé (toutes les 6 h) a déjà enregistré.
 * Contrat d'URL : `/stats?sort=recent|views&days=30|90|365`.
 */

const PERIODS = [30, 90, 365] as const;

function parseDays(raw: string | undefined): number {
  const n = Number(raw);
  return (PERIODS as readonly number[]).includes(n) ? n : 30;
}

function statsHref(sort: "recent" | "views", days: number) {
  const params = new URLSearchParams();
  if (sort !== "recent") params.set("sort", sort);
  if (days !== 30) params.set("days", String(days));
  const qs = params.toString();
  return qs ? `/stats?${qs}` : "/stats";
}

export default async function StatsPage(props: PageProps<"/stats">) {
  const session = await verifySession();
  const user = await getCurrentUser();
  const timezone = user?.timezone ?? "Europe/Paris";
  const searchParams = await props.searchParams;
  const rawSort = Array.isArray(searchParams.sort) ? searchParams.sort[0] : searchParams.sort;
  const rawDays = Array.isArray(searchParams.days) ? searchParams.days[0] : searchParams.days;
  const sort = rawSort === "views" ? "views" : "recent";
  const days = parseDays(rawDays);

  const stats = await getInstagramStatsForUser(session.userId, { days, limit: 100, sort });

  if (!stats.account) {
    return (
      <div className="space-y-4">
        <PageHeader title="Statistiques" description="Vues et réactions de vos publications Instagram." />
        <EmptyState
          icon={BarChart3}
          title="Aucun compte Instagram connecté"
          description="Connectez Instagram pour suivre les vues de vos Reels."
          action={
            <Link href="/connections" className={buttonVariants({ size: "sm" })}>
              Connexions
            </Link>
          }
        />
      </div>
    );
  }

  const state = stats.account.state;
  const recentDays = stats.days.slice(-14).reverse();

  return (
    <div className="space-y-5">
      <PageHeader
        title="Statistiques"
        description={
          <>
            Instagram @{stats.account.username} — relevé automatique toutes les 6 h
            {state ? ` (dernier : ${formatInTimeZone(new Date(state.lastRunAt), timezone, "dd/MM 'à' HH:mm")})` : ""}.
          </>
        }
      />

      {stats.account.scope === "missing" && (
        <Alert>
          <AlertTriangle className="size-4" />
          <AlertTitle>Statistiques à autoriser</AlertTitle>
          <AlertDescription className="text-[12.5px]">
            {RECONNECT_FOR_STATS_MESSAGE}{" "}
            <Link href="/connections" className="underline">
              Ouvrir Connexions
            </Link>
          </AlertDescription>
        </Alert>
      )}
      {stats.account.collecting && (
        <Alert>
          <AlertTriangle className="size-4" />
          <AlertTitle>Premier relevé en cours</AlertTitle>
          <AlertDescription className="text-[12.5px]">
            L’accès aux statistiques est accordé : le premier relevé (tout l’historique du compte) prend quelques
            minutes. Rechargez la page ensuite.
          </AlertDescription>
        </Alert>
      )}
      {state && !state.ok && state.error && stats.account.scope !== "missing" && !stats.account.collecting && (
        <Alert variant="destructive">
          <AlertTriangle className="size-4" />
          <AlertTitle>Dernier relevé incomplet</AlertTitle>
          <AlertDescription className="text-[12.5px]">{state.error}</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard
          label="Vues du compte, 7 derniers jours"
          value={statNumber(stats.totals?.views7d.value)}
          detail={stats.totals ? `${stats.totals.views7d.daysWithData}/7 journées relevées` : undefined}
        />
        <StatCard
          label="Vues du compte, 30 derniers jours"
          value={statNumber(stats.totals?.views30d.value)}
          detail={stats.totals ? `${stats.totals.views30d.daysWithData}/30 journées relevées` : undefined}
        />
        <StatCard
          label={`Publications sur ${days === 365 ? "1 an" : `${days} jours`}`}
          value={statNumber(stats.mediaTotal)}
          detail={state?.mediaPending ? `${state.mediaPending} en attente de relevé` : undefined}
        />
      </div>

      <Card className="gap-0 px-0 py-0">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
          <p className="text-[13px] font-semibold">
            Reels et publications
            {stats.mediaTotal > stats.media.length && (
              <span className="ml-1.5 font-normal text-muted-foreground">
                ({stats.media.length} premiers sur {stats.mediaTotal})
              </span>
            )}
          </p>
          <div className="flex flex-wrap gap-1.5 text-[12px]">
            {(["recent", "views"] as const).map((s) => (
              <Link
                key={s}
                href={statsHref(s, days)}
                className={cn(buttonVariants({ variant: sort === s ? "secondary" : "ghost", size: "xs" }))}
              >
                {s === "recent" ? "Plus récents" : "Plus vus"}
              </Link>
            ))}
            <span className="mx-1 text-border">|</span>
            {PERIODS.map((d) => (
              <Link
                key={d}
                href={statsHref(sort, d)}
                className={cn(buttonVariants({ variant: days === d ? "secondary" : "ghost", size: "xs" }))}
              >
                {d === 365 ? "1 an" : `${d} j`}
              </Link>
            ))}
          </div>
        </div>
        {stats.media.length === 0 ? (
          <p className="px-4 py-6 text-[12.5px] text-muted-foreground">
            {stats.account.collecting || !state ? "Premier relevé pas encore fait." : "Aucune publication relevée sur cette période."}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {stats.media.map((m) => (
              <li key={m.mediaId} className="space-y-1.5 px-4 py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <p className="min-w-0 flex-1 truncate text-[13px]">
                    <span className="mr-2 text-[11.5px] font-medium text-muted-foreground">
                      {formatInTimeZone(m.postedAt, timezone, "dd/MM/yy")} · {m.type === "REELS" ? "Reel" : "Publication"}
                    </span>
                    {m.permalink ? (
                      <a href={m.permalink} target="_blank" rel="noreferrer" className="hover:underline">
                        {m.caption ?? "Sans légende"}
                      </a>
                    ) : (
                      (m.caption ?? "Sans légende")
                    )}
                  </p>
                  {m.postId && (
                    <Link href={`/composer/${m.postId}`} className="text-[11.5px] text-primary-strong hover:underline">
                      Post Social Master
                    </Link>
                  )}
                </div>
                <dl className="grid grid-cols-3 gap-x-3 gap-y-1 text-[12px] sm:grid-cols-7">
                  {(
                    [
                      ["Vues", statNumber(m.views)],
                      ["Touchés", statNumber(m.reach)],
                      ["J’aime", statNumber(m.likes)],
                      ["Partages", statNumber(m.shares)],
                      ["Enreg.", statNumber(m.saved)],
                      ["Visionnage", m.type === "REELS" ? statSeconds(m.avgWatchSeconds) : "—"],
                      ["Zappé 3 s", m.type === "REELS" ? statPercent(m.skipRatePct) : "—"],
                    ] as Array<[string, string]>
                  ).map(([label, value]) => (
                    <div key={label}>
                      <dt className="text-[11px] text-muted-foreground">{label}</dt>
                      <dd className="font-semibold tabular-nums">{value}</dd>
                    </div>
                  ))}
                </dl>
                {!m.fetchedAt && <p className="text-[11.5px] text-muted-foreground">Statistiques pas encore relevées.</p>}
                {m.error && <p className="text-[11.5px] text-destructive">{m.error}</p>}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {recentDays.length > 0 && (
        <Card className="gap-0 px-0 py-0">
          <p className="border-b border-border px-4 py-3 text-[13px] font-semibold">Vues du compte, jour par jour</p>
          <ul className="divide-y divide-border text-[12.5px]">
            {recentDays.map((d) => (
              <li key={d.day} className="flex items-center justify-between px-4 py-2">
                <span className="text-muted-foreground">{formatInTimeZone(new Date(`${d.day}T12:00:00Z`), "UTC", "EEE dd/MM", { locale: fr })}</span>
                <span className="tabular-nums">
                  <span className="font-semibold">{statNumber(d.views)}</span> vues ·{" "}
                  <span className="text-muted-foreground">{statNumber(d.reach)} comptes touchés</span>
                </span>
              </li>
            ))}
          </ul>
          <p className="px-4 py-2.5 text-[11.5px] text-muted-foreground">
            Journées Meta (minuit-minuit heure de Californie, soit 9 h-9 h à Paris). Les 2 derniers jours peuvent encore
            augmenter.
          </p>
        </Card>
      )}

      <p className="text-[11.5px] text-muted-foreground">
        Vues = lectures organiques sur Instagram (hors pub et hors Facebook), souvent un peu moins que le chiffre de
        l’app. « — » = non renvoyé par Meta (ce n’est pas un zéro).
      </p>
    </div>
  );
}
