import { formatInTimeZone } from "date-fns-tz";
import { Card } from "@/components/ui/card";
import type { InstagramMediaStatsView } from "@/lib/instagram-stats-service";

const nf = new Intl.NumberFormat("fr-FR");

/** Nombre affiché, « — » quand Meta n'a rien renvoyé (jamais confondu avec 0). */
export function statNumber(value: number | null | undefined): string {
  return value == null ? "—" : nf.format(value);
}

export function statSeconds(value: number | null | undefined): string {
  return value == null ? "—" : `${nf.format(value)} s`;
}

export function statPercent(value: number | null | undefined): string {
  return value == null ? "—" : `${nf.format(value)} %`;
}

/** Statistiques d'un média Instagram (page d'un post publié) — CLAUDE.md §43. */
export function InstagramMediaStats({ stats, timezone }: { stats: InstagramMediaStatsView; timezone: string }) {
  const isReel = stats.type === "REELS";
  const items: Array<[string, string]> = [
    ["Vues", statNumber(stats.views)],
    ["Comptes touchés", statNumber(stats.reach)],
    ["J’aime", statNumber(stats.likes)],
    ["Commentaires", statNumber(stats.comments)],
    ["Partages", statNumber(stats.shares)],
    ["Enregistrements", statNumber(stats.saved)],
    ...(isReel
      ? ([
          ["Visionnage moyen", statSeconds(stats.avgWatchSeconds)],
          ["Zappé dans les 3 s", statPercent(stats.skipRatePct)],
        ] as Array<[string, string]>)
      : []),
  ];
  return (
    <Card className="gap-3 px-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-[13px] font-semibold">Statistiques Instagram</p>
        {stats.fetchedAt && (
          <p className="text-[11.5px] text-muted-foreground">
            relevées le {formatInTimeZone(stats.fetchedAt, timezone, "dd/MM 'à' HH:mm")}
          </p>
        )}
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 sm:grid-cols-4">
        {items.map(([label, value]) => (
          <div key={label}>
            <dt className="text-[11.5px] text-muted-foreground">{label}</dt>
            <dd className="text-[15px] font-semibold tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="text-[11.5px] text-muted-foreground">
        Vues organiques sur Instagram (hors pub et hors Facebook). Meta annonce jusqu’à 48 h de retard ; « — » = non
        renvoyé par Meta.
      </p>
      {stats.error && <p className="text-[11.5px] text-destructive">{stats.error}</p>}
    </Card>
  );
}
