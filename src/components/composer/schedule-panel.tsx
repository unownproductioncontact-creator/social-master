"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { formatInTimeZone } from "date-fns-tz";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { StatusBadge, postStatusTone, postStatusLabel } from "@/components/ui/status-badge";
import { PlatformChip } from "@/components/ui/platform-chip";
import { scheduleExistingPost, unschedulePostAction } from "@/lib/actions/posts";

type TargetStatus = {
  id: string;
  platform: string;
  status: string;
  errorMessage: string | null;
  platformPostUrl: string | null;
  /** Horaire effectif propre à cette cible (peut différer de Post.scheduledAt, ex. IG à H+5min). */
  scheduledAt: Date | null;
};

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
  const defaultValue = scheduledAt ? formatInTimeZone(scheduledAt, timezone, "yyyy-MM-dd'T'HH:mm") : "";
  const [dateTime, setDateTime] = useState(defaultValue);

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

  const isScheduledOrBeyond = postStatus !== "DRAFT";

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
              <Input
                id="scheduled-at"
                type="datetime-local"
                value={dateTime}
                onChange={(e) => setDateTime(e.target.value)}
              />
            </div>
            <Button onClick={handleSchedule} disabled={isPending || !dateTime || !canSchedule} className="w-full sm:w-auto">
              {isPending ? "Programmation…" : "Programmer"}
            </Button>
            {!canSchedule && (
              <p className="text-xs text-muted-foreground">
                Enregistrez d’abord le brouillon avec un média et au moins une plateforme.
              </p>
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
            <div className="space-y-2">
              {targets.map((target) => (
                <div key={target.id} className="flex items-center justify-between gap-2 text-[13.5px]">
                  <PlatformChip
                    platform={target.platform}
                    time={(() => {
                      const effective = target.scheduledAt ?? scheduledAt;
                      return effective ? formatInTimeZone(effective, timezone, "HH:mm") : undefined;
                    })()}
                  />
                  <div className="flex items-center gap-2">
                    <StatusBadge tone={postStatusTone(target.status)}>
                      {postStatusLabel(target.status)}
                    </StatusBadge>
                    {target.platformPostUrl && (
                      <a href={target.platformPostUrl} target="_blank" rel="noreferrer" className="text-xs font-semibold text-primary underline-offset-4 hover:underline">
                        Voir
                      </a>
                    )}
                  </div>
                </div>
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
            <Button variant="ghost" size="sm" onClick={handleUnschedule} disabled={isPending} className="w-full sm:w-auto">
              {postStatus === "SCHEDULED" ? "Annuler la programmation" : "Repasser en brouillon pour corriger"}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
