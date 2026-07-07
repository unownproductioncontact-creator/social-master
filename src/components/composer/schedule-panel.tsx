"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { formatInTimeZone } from "date-fns-tz";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { scheduleExistingPost, unschedulePostAction } from "@/lib/actions/posts";

type TargetStatus = {
  id: string;
  platform: string;
  status: string;
  errorMessage: string | null;
  platformPostUrl: string | null;
};

const STATUS_LABELS: Record<string, string> = {
  PENDING: "En attente",
  PROCESSING: "En cours",
  PUBLISHED: "Publié",
  SENT_TO_INBOX: "Envoyé en brouillon TikTok",
  FAILED: "Échoué",
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
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Programmation</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {!isScheduledOrBeyond ? (
          <div className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="scheduled-at">Date et heure ({timezone})</Label>
              <Input
                id="scheduled-at"
                type="datetime-local"
                value={dateTime}
                onChange={(e) => setDateTime(e.target.value)}
              />
            </div>
            <Button onClick={handleSchedule} disabled={isPending || !dateTime || !canSchedule}>
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
            <p className="text-sm">
              Programmé pour le{" "}
              <span className="font-medium">
                {scheduledAt ? formatInTimeZone(scheduledAt, timezone, "dd/MM/yyyy à HH:mm") : "—"}
              </span>
            </p>
            <div className="space-y-2">
              {targets.map((target) => (
                <div key={target.id} className="flex items-center justify-between gap-2 text-sm">
                  <span>{target.platform}</span>
                  <div className="flex items-center gap-2">
                    <Badge variant={target.status === "FAILED" ? "destructive" : "secondary"}>
                      {STATUS_LABELS[target.status] ?? target.status}
                    </Badge>
                    {target.platformPostUrl && (
                      <a href={target.platformPostUrl} target="_blank" rel="noreferrer" className="text-xs underline">
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
            <Button variant="ghost" size="sm" onClick={handleUnschedule} disabled={isPending}>
              {postStatus === "SCHEDULED" ? "Annuler la programmation" : "Repasser en brouillon pour corriger"}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
