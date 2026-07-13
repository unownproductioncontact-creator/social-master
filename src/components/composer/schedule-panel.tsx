"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { Button } from "@/components/ui/button";
import { DateTimePicker } from "@/components/ui/datetime-picker";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { StatusBadge, postStatusTone, postStatusLabel } from "@/components/ui/status-badge";
import { PlatformChip } from "@/components/ui/platform-chip";
import { scheduleExistingPost, unschedulePostAction, reschedulePostAction } from "@/lib/actions/posts";
import { isInQuietWindow, suggestWakeTime, QUIET_WINDOW_LABEL } from "@/lib/schedule-window";

type TargetStatus = {
  id: string;
  platform: string;
  status: string;
  errorMessage: string | null;
  platformPostUrl: string | null;
  /** Horaire effectif propre à cette cible (peut différer de Post.scheduledAt, ex. IG à H+5min). */
  scheduledAt: Date | null;
};

/** Format `datetime-local` (valeur d'un <input type="datetime-local">), partagé par tous les champs de ce panneau. */
const DATETIME_LOCAL_FORMAT = "yyyy-MM-dd'T'HH:mm";

/**
 * Encart d'avertissement fenêtre morte 23h-7h (P1-3), inline et jamais bloquant : le service dort la
 * nuit pour économiser les heures Render (CLAUDE.md §21), une publication programmée dans ce créneau
 * ne partira qu'au réveil. Rendu par la programmation ET la reprogrammation (même composant, DRY).
 */
function QuietWindowNotice({
  value,
  timezone,
  onShiftToWakeTime,
}: {
  value: string;
  timezone: string;
  onShiftToWakeTime: (nextValue: string) => void;
}) {
  const parsed = value ? fromZonedTime(value, timezone) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || !isInQuietWindow(parsed, timezone)) {
    return null;
  }
  // Re-liaison sur une nouvelle const : conserve le type `Date` (non-null) dans la fermeture ci-dessous.
  const quietMoment = parsed;

  function handleShift() {
    const wakeTime = suggestWakeTime(quietMoment, timezone);
    onShiftToWakeTime(formatInTimeZone(wakeTime, timezone, DATETIME_LOCAL_FORMAT));
  }

  return (
    <div className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-xs text-amber-700 dark:text-amber-400">
      <p>{QUIET_WINDOW_LABEL}</p>
      <Button
        variant="outline"
        size="xs"
        onClick={handleShift}
        className="border-amber-500/40 bg-transparent text-amber-700 hover:bg-amber-500/15 dark:text-amber-400"
      >
        Décaler à 7h10
      </Button>
    </div>
  );
}

/** Une ligne de cible (puce plateforme + statut + lien éventuel) — logique inchangée, factorisée pour être réutilisée sur tous les statuts (y compris les cibles déjà servies d'un brouillon, voir plus bas). */
function TargetRow({
  target,
  fallbackScheduledAt,
  timezone,
}: {
  target: TargetStatus;
  fallbackScheduledAt: Date | null;
  timezone: string;
}) {
  const effective = target.scheduledAt ?? fallbackScheduledAt;
  return (
    <div className="flex items-center justify-between gap-2 text-[13.5px]">
      <PlatformChip platform={target.platform} time={effective ? formatInTimeZone(effective, timezone, "HH:mm") : undefined} />
      <div className="flex items-center gap-2">
        <StatusBadge tone={postStatusTone(target.status)}>{postStatusLabel(target.status)}</StatusBadge>
        {target.platformPostUrl && (
          <a href={target.platformPostUrl} target="_blank" rel="noreferrer" className="text-xs font-semibold text-primary underline-offset-4 hover:underline">
            Voir
          </a>
        )}
      </div>
    </div>
  );
}

/** Liste complète des cibles + bandeau d'erreurs — même rendu que l'ancien bloc inline, simplement extrait. */
function TargetList({ targets, scheduledAt, timezone }: { targets: TargetStatus[]; scheduledAt: Date | null; timezone: string }) {
  return (
    <div className="space-y-2">
      {targets.map((target) => (
        <TargetRow key={target.id} target={target} fallbackScheduledAt={scheduledAt} timezone={timezone} />
      ))}
      {targets.some((t) => t.errorMessage) && (
        <div className="space-y-1 rounded-md bg-destructive/10 p-2 text-xs text-destructive">
          {targets
            .filter((t) => t.errorMessage)
            .map((t) => (
              <p key={t.id}>
                {t.platform} : {t.errorMessage}
              </p>
            ))}
        </div>
      )}
    </div>
  );
}

export function SchedulePanel({
  postId,
  postStatus,
  scheduledAt,
  timezone,
  targets,
  canSchedule,
}: {
  postId: string;
  postStatus: string;
  scheduledAt: Date | null;
  timezone: string;
  targets: TargetStatus[];
  canSchedule: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const defaultValue = scheduledAt ? formatInTimeZone(scheduledAt, timezone, DATETIME_LOCAL_FORMAT) : "";
  const [dateTime, setDateTime] = useState(defaultValue);

  // Repli « Modifier l'horaire » (P2-4, SCHEDULED uniquement) : replié par défaut, pré-rempli à
  // l'ouverture avec l'horaire actuel (même valeur que `defaultValue`).
  const [isEditingSchedule, setIsEditingSchedule] = useState(false);
  const [rescheduleValue, setRescheduleValue] = useState(defaultValue);

  function handleSchedule() {
    startTransition(async () => {
      const result = await scheduleExistingPost({ postId, scheduledAtLocal: dateTime, timezone });
      if (result.error) {
        toast.error(result.error);
        return;
      }
      toast.success("Post programmé.");
      router.refresh();
    });
  }

  function handleUnschedule() {
    startTransition(async () => {
      await unschedulePostAction(postId);
      toast.success("Programmation annulée, le post redevient un brouillon.");
      router.refresh();
    });
  }

  function handleOpenReschedule() {
    setRescheduleValue(defaultValue);
    setIsEditingSchedule(true);
  }

  function handleReschedule() {
    startTransition(async () => {
      const result = await reschedulePostAction({ postId, scheduledAtLocal: rescheduleValue, timezone });
      if (result.error) {
        toast.error(result.error);
        return;
      }
      toast.success("Horaire mis à jour.");
      setIsEditingSchedule(false);
      router.refresh();
    });
  }

  const isScheduledOrBeyond = postStatus !== "DRAFT";
  // Cibles déjà servies (P1-2) : un brouillon peut désormais en porter (post partiellement publié
  // repassé en brouillon pour corriger l'autre plateforme) — savePostDraft ne les recrée jamais.
  const servedTargets = targets.filter((t) => t.status === "PUBLISHED" || t.status === "SENT_TO_INBOX");

  return (
    <Card className="gap-0 py-0">
      <h3 className="border-b border-border px-[15px] py-3 text-[13.5px] font-semibold">Programmation</h3>
      <CardContent className="space-y-4 py-3.5">
        {!isScheduledOrBeyond ? (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="scheduled-at" className="text-xs font-semibold">
                Date et heure ({timezone})
              </Label>
              <DateTimePicker
                id="scheduled-at"
                value={dateTime}
                onChange={setDateTime}
                timezone={timezone}
              />
            </div>
            <QuietWindowNotice value={dateTime} timezone={timezone} onShiftToWakeTime={setDateTime} />
            <Button onClick={handleSchedule} disabled={isPending || !dateTime || !canSchedule} className="w-full sm:w-auto">
              {isPending ? "Programmation…" : "Programmer"}
            </Button>
            {!canSchedule && (
              <p className="text-xs text-muted-foreground">
                Enregistrez d’abord le brouillon avec un média et au moins une plateforme.
              </p>
            )}
            {servedTargets.length > 0 && (
              <div className="space-y-2 border-t border-border pt-3">
                <p className="text-xs font-semibold text-muted-foreground">Déjà transmis :</p>
                {servedTargets.map((target) => (
                  <TargetRow key={target.id} target={target} fallbackScheduledAt={scheduledAt} timezone={timezone} />
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-[13.5px]">
              Programmé pour le{" "}
              <span className="font-semibold">
                {scheduledAt ? formatInTimeZone(scheduledAt, timezone, "dd/MM/yyyy à HH:mm") : "—"}
              </span>
            </p>
            <TargetList targets={targets} scheduledAt={scheduledAt} timezone={timezone} />

            {postStatus === "SCHEDULED" &&
              (isEditingSchedule ? (
                <div className="space-y-3 rounded-md border border-border p-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="reschedule-at" className="text-xs font-semibold">
                      Nouvelle date et heure ({timezone})
                    </Label>
                    <DateTimePicker
                      id="reschedule-at"
                      value={rescheduleValue}
                      onChange={setRescheduleValue}
                      timezone={timezone}
                    />
                  </div>
                  <QuietWindowNotice value={rescheduleValue} timezone={timezone} onShiftToWakeTime={setRescheduleValue} />
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" onClick={handleReschedule} disabled={isPending || !rescheduleValue}>
                      {isPending ? "Reprogrammation…" : "Reprogrammer"}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setIsEditingSchedule(false)} disabled={isPending}>
                      Annuler
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" size="sm" onClick={handleOpenReschedule} disabled={isPending}>
                    Modifier l’horaire
                  </Button>
                  <Button variant="ghost" size="sm" onClick={handleUnschedule} disabled={isPending}>
                    Annuler la programmation
                  </Button>
                </div>
              ))}

            {(postStatus === "FAILED" || postStatus === "PARTIALLY_PUBLISHED") && (
              <div className="space-y-2">
                <Button variant="ghost" size="sm" onClick={handleUnschedule} disabled={isPending} className="w-full sm:w-auto">
                  Corriger (repasser en brouillon)
                </Button>
                {postStatus === "PARTIALLY_PUBLISHED" && (
                  <p className="text-xs text-muted-foreground">Les cibles déjà publiées seront conservées.</p>
                )}
              </div>
            )}

            {postStatus === "PUBLISHED" && (
              <p className="text-[13.5px] text-muted-foreground">Publié — ce post n’est plus modifiable.</p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
