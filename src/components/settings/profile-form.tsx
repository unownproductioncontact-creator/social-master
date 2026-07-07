"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { updateProfile } from "@/lib/actions/settings";

const TIMEZONES = ["Europe/Paris", "Europe/London", "America/New_York", "America/Los_Angeles", "Asia/Tokyo"];

export function ProfileForm({ name, email, timezone }: { name: string | null; email: string; timezone: string }) {
  const [isPending, startTransition] = useTransition();
  const [nameValue, setNameValue] = useState(name ?? "");
  const [timezoneValue, setTimezoneValue] = useState(timezone);

  function handleSave() {
    startTransition(async () => {
      const result = await updateProfile({ name: nameValue, timezone: timezoneValue });
      if (result.error) {
        toast.error(result.error);
        return;
      }
      toast.success("Profil mis à jour.");
    });
  }

  return (
    <div className="max-w-md space-y-4">
      <div className="space-y-2">
        <Label htmlFor="name">Nom</Label>
        <Input id="name" value={nameValue} onChange={(e) => setNameValue(e.target.value)} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="email">Email</Label>
        <Input id="email" value={email} disabled />
      </div>
      <div className="space-y-2">
        <Label htmlFor="timezone">Fuseau horaire</Label>
        <Select value={timezoneValue} onValueChange={(value) => setTimezoneValue(value as string)}>
          <SelectTrigger id="timezone" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TIMEZONES.map((tz) => (
              <SelectItem key={tz} value={tz}>
                {tz}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Button onClick={handleSave} disabled={isPending}>
        {isPending ? "Enregistrement…" : "Enregistrer"}
      </Button>
    </div>
  );
}
