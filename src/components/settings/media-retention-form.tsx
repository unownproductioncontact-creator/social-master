"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { updateMediaRetention } from "@/lib/actions/settings";

const OPTIONS = [
  { value: "never", label: "Jamais" },
  { value: "7", label: "7 jours" },
  { value: "30", label: "30 jours" },
  { value: "90", label: "90 jours" },
] as const;

/** Mappe la valeur du <select> (chaîne) vers le palier attendu par la Server Action. */
function toRetentionDays(value: string): 7 | 30 | 90 | null {
  switch (value) {
    case "7":
      return 7;
    case "30":
      return 30;
    case "90":
      return 90;
    default:
      return null;
  }
}

export function MediaRetentionForm({ mediaRetentionDays }: { mediaRetentionDays: number | null }) {
  const [isPending, startTransition] = useTransition();
  const [value, setValue] = useState<string>(mediaRetentionDays == null ? "never" : String(mediaRetentionDays));

  function handleSave() {
    startTransition(async () => {
      const result = await updateMediaRetention({ mediaRetentionDays: toRetentionDays(value) });
      if (result.error) {
        toast.error(result.error);
        return;
      }
      toast.success("Préférence de rétention enregistrée.");
    });
  }

  return (
    <div className="space-y-3.5">
      <div className="space-y-1.5">
        <Label htmlFor="media-retention" className="text-[12.5px] font-semibold text-foreground">
          Supprimer automatiquement les médias publiés après
        </Label>
        <Select value={value} onValueChange={(v) => setValue(v as string)}>
          <SelectTrigger id="media-retention" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <p className="text-[12px] text-muted-foreground">
        Seuls les médias dont toutes les publications sont parties sont concernés. Les fichiers sont
        supprimés du stockage.
      </p>
      <Button onClick={handleSave} disabled={isPending}>
        {isPending ? "Enregistrement…" : "Enregistrer"}
      </Button>
    </div>
  );
}
