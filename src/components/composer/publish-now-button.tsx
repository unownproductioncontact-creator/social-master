"use client";

import { useState } from "react";
import { Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

/**
 * Bouton « Publier maintenant » + confirmation. La publication immédiate part sur-le-champ et, pour
 * Instagram/YouTube, est PUBLIQUE et irréversible → on demande confirmation (un simple clic ne doit pas
 * publier par erreur). Le composant ne gère ni l'appel serveur ni les toasts : il délègue à `onConfirm`
 * (le composer enregistre-puis-publie ; le SchedulePanel publie un brouillon existant).
 */
export function PublishNowButton({
  onConfirm,
  disabled,
  platforms,
  size = "default",
  className,
}: {
  onConfirm: () => void;
  disabled?: boolean;
  platforms: { instagram?: boolean; tiktok?: boolean; youtube?: boolean };
  size?: "default" | "sm";
  className?: string;
}) {
  const [open, setOpen] = useState(false);

  const publicNames = [platforms.instagram && "Instagram", platforms.youtube && "YouTube"].filter(
    Boolean
  ) as string[];

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={<Button variant="outline" size={size} disabled={disabled} className={className} />}
      >
        <Zap className="size-4" />
        Publier maintenant
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Publier maintenant ?</DialogTitle>
          <DialogDescription>
            La publication part <span className="font-medium text-foreground">immédiatement</span>.
            {publicNames.length > 0 && (
              <> {publicNames.join(" et ")} {publicNames.length > 1 ? "sont publiés" : "est publié"} en public — action irréversible.</>
            )}
            {platforms.tiktok && <> La vidéo TikTok arrive en brouillon dans vos notifications.</>}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Annuler</DialogClose>
          <Button
            onClick={() => {
              setOpen(false);
              onConfirm();
            }}
          >
            <Zap className="size-4" />
            Publier maintenant
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
