"use client";

import * as React from "react";
import { format, parse } from "date-fns";
import { fr } from "date-fns/locale";
import { formatInTimeZone } from "date-fns-tz";
import { CalendarDays, Clock } from "lucide-react";

import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * Sélecteur date + heure ERGONOMIQUE, en remplacement des `<input type="datetime-local">` natifs
 * (petits, fumeux, incohérents entre navigateurs). Un calendrier visuel (react-day-picker) pour la
 * date + une liste d'horaires par pas de 15 min pour l'heure.
 *
 * CONTRAT INCHANGÉ : `value`/`onChange` manipulent une chaîne datetime-local `yyyy-MM-dd'T'HH:mm`
 * (heure murale, comme avant), donc toute la logique appelante (fromZonedTime, fenêtre 23h-7h,
 * validation serveur) reste identique. Aucune conversion via UTC ici : on ne fait que découper/
 * recomposer la chaîne (aucune dérive de fuseau ni de changement d'heure).
 */

const pad = (n: number) => String(n).padStart(2, "0");

/** Créneaux horaires par 15 min : "00:00" … "23:45" (96 options), listés une seule fois. */
const TIME_OPTIONS: string[] = (() => {
  const out: string[] = [];
  for (let h = 0; h < 24; h += 1) {
    for (let m = 0; m < 60; m += 15) out.push(`${pad(h)}:${pad(m)}`);
  }
  return out;
})();

/** Heure par défaut quand on choisit une date alors qu'aucune n'était posée (aligné sur « Demain 18h »). */
const DEFAULT_TIME = "18:00";

/** Découpe "yyyy-MM-dd'T'HH:mm" → { datePart, timePart } ; parties vides si `value` vide/incomplète. */
function splitValue(value: string): { datePart: string; timePart: string } {
  const [datePart = "", timePart = ""] = value.split("T");
  return { datePart, timePart };
}

/** Date LOCALE (minuit) correspondant à "yyyy-MM-dd", ou undefined. Sert au calendrier (jour civil pur). */
function localDateFromPart(datePart: string): Date | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return undefined;
  const d = parse(datePart, "yyyy-MM-dd", new Date());
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export function DateTimePicker({
  value,
  onChange,
  timezone,
  disablePast = true,
  disabled = false,
  id,
  className,
}: {
  /** Chaîne datetime-local "yyyy-MM-dd'T'HH:mm", ou "" (aucune date choisie). */
  value: string;
  onChange: (value: string) => void;
  /** Fuseau de l'utilisateur — sert uniquement à déterminer « aujourd'hui » (jours passés désactivés). */
  timezone: string;
  /** Désactive la sélection des jours antérieurs à aujourd'hui (par défaut true). */
  disablePast?: boolean;
  disabled?: boolean;
  id?: string;
  className?: string;
}) {
  const [dateOpen, setDateOpen] = React.useState(false);
  const { datePart, timePart } = splitValue(value);
  const selectedDate = localDateFromPart(datePart);

  // « Aujourd'hui » dans le fuseau de l'utilisateur (borne basse des jours sélectionnables).
  const todayLocal = React.useMemo(
    () => localDateFromPart(formatInTimeZone(new Date(), timezone, "yyyy-MM-dd")),
    [timezone]
  );

  // Créneaux : on injecte l'horaire courant s'il n'est pas sur la grille de 15 min (ex. « Dans 1 h »
  // = 14:37) pour ne jamais le perdre ni afficher un champ vide.
  const timeItems = React.useMemo(() => {
    if (timePart && /^\d{2}:\d{2}$/.test(timePart) && !TIME_OPTIONS.includes(timePart)) {
      return [timePart, ...TIME_OPTIONS];
    }
    return TIME_OPTIONS;
  }, [timePart]);

  function handleDaySelect(day: Date | undefined) {
    if (!day) return;
    const nextDate = format(day, "yyyy-MM-dd");
    onChange(`${nextDate}T${timePart || DEFAULT_TIME}`);
    setDateOpen(false);
  }

  function handleTimeSelect(nextTime: unknown) {
    if (typeof nextTime !== "string" || !nextTime) return;
    const nextDate = datePart || formatInTimeZone(new Date(), timezone, "yyyy-MM-dd");
    onChange(`${nextDate}T${nextTime}`);
  }

  const dateLabel = selectedDate
    ? format(selectedDate, "EEE d MMM yyyy", { locale: fr })
    : "Choisir une date";

  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      {/* Date — calendrier dans un popover */}
      <Popover open={dateOpen} onOpenChange={setDateOpen}>
        <PopoverTrigger
          id={id}
          disabled={disabled}
          className={cn(
            buttonVariants({ variant: "outline", size: "sm" }),
            "h-8 justify-start gap-2 font-normal capitalize",
            !selectedDate && "text-muted-foreground"
          )}
        >
          <CalendarDays className="size-4 text-muted-foreground" />
          {dateLabel}
        </PopoverTrigger>
        <PopoverContent align="start" className="w-auto p-0">
          <Calendar
            mode="single"
            locale={fr}
            selected={selectedDate}
            defaultMonth={selectedDate ?? todayLocal}
            onSelect={handleDaySelect}
            disabled={disablePast && todayLocal ? { before: todayLocal } : undefined}
            autoFocus
          />
        </PopoverContent>
      </Popover>

      {/* Heure — liste de créneaux 15 min */}
      <Select value={timePart || null} onValueChange={handleTimeSelect} disabled={disabled}>
        <SelectTrigger size="sm" className="h-8 gap-1.5 tabular-nums">
          <Clock className="size-4 text-muted-foreground" />
          <SelectValue placeholder="Heure" />
        </SelectTrigger>
        <SelectContent className="max-h-64">
          {timeItems.map((t) => (
            <SelectItem key={t} value={t} className="tabular-nums">
              {t}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
