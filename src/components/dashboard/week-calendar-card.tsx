import Link from "next/link";
import { formatInTimeZone } from "date-fns-tz";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

const DOW = ["L", "M", "M", "J", "V", "S", "D"];

/**
 * Mini-calendrier de la semaine courante (maquette .cal) : entête « Mois Année » + « sem. N »,
 * une seule rangée de 7 jours (lundi→dimanche, fuseau du user), aujourd'hui en accent, pip sous
 * les jours ayant ≥1 publication programmée. Toute la carte est cliquable → /calendar.
 */
export function WeekCalendarCard({
  weekDays,
  monthLabel,
  weekNumber,
  todayKey,
  scheduledDayKeys,
}: {
  /** Les 7 jours de la semaine (UTC minuit du jour local), du lundi au dimanche. */
  weekDays: Date[];
  /** Libellé « juillet 2026 » (mois du jour courant, minuscule → capitalisé en CSS). */
  monthLabel: string;
  weekNumber: number;
  /** Clé yyyy-MM-dd (fuseau user) du jour courant. */
  todayKey: string;
  /** Clés yyyy-MM-dd (fuseau user) des jours ayant ≥1 publication programmée. */
  scheduledDayKeys: Set<string>;
}) {
  return (
    <Card className="gap-0 px-[15px] py-[13px]">
      <Link href="/calendar" className="block">
        <div className="mb-2.5 flex items-center justify-between text-[12.5px] font-semibold">
          <span className="capitalize">{monthLabel}</span>
          <span className="font-medium text-muted-foreground">sem. {weekNumber}</span>
        </div>
        <div className="grid grid-cols-7 gap-1.5 text-center">
          {DOW.map((d, i) => (
            <span
              key={i}
              className="text-[10px] font-semibold uppercase tracking-[0.05em] text-muted-foreground"
            >
              {d}
            </span>
          ))}
          {weekDays.map((day) => {
            const key = formatInTimeZone(day, "UTC", "yyyy-MM-dd");
            const dayNum = formatInTimeZone(day, "UTC", "d");
            const isToday = key === todayKey;
            const hasPost = scheduledDayKeys.has(key);
            return (
              <span
                key={key}
                className={cn(
                  "flex aspect-square flex-col items-center justify-center gap-[3px] rounded-lg text-[12px] tabular-nums",
                  isToday
                    ? "bg-primary-strong font-bold text-primary-foreground"
                    : "text-secondary-foreground"
                )}
              >
                {dayNum}
                {hasPost && (
                  <span
                    aria-hidden="true"
                    className={cn(
                      "size-[5px] rounded-full",
                      isToday ? "bg-white" : "bg-primary-strong"
                    )}
                  />
                )}
              </span>
            );
          })}
        </div>
      </Link>
    </Card>
  );
}
