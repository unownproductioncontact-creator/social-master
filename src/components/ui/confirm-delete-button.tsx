"use client";

import { useState, useTransition, type ReactNode } from "react";
import { toast } from "sonner";
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
import { cn } from "@/lib/utils";

type ActionResult = { error?: string } | void;

/**
 * Bouton « Supprimer » qui ouvre une confirmation avant d'exécuter une Server Action.
 * `onConfirm` est une action serveur (souvent liée à un id via `.bind(null, id)`) : si elle renvoie
 * `{ error }`, le message s'affiche en toast et la boîte se ferme ; sinon c'est un succès (une action
 * qui redirige navigue directement). Corrige le cas où une suppression échouait en silence.
 */
export function ConfirmDeleteButton({
  onConfirm,
  title,
  description,
  triggerLabel = "Supprimer",
  confirmLabel = "Supprimer",
  successMessage,
  triggerClassName,
  triggerFullWidth = false,
}: {
  onConfirm: () => Promise<ActionResult>;
  title: string;
  description: ReactNode;
  triggerLabel?: string;
  confirmLabel?: string;
  successMessage?: string;
  triggerClassName?: string;
  triggerFullWidth?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  function handleConfirm() {
    startTransition(async () => {
      const result = await onConfirm();
      if (result && "error" in result && result.error) {
        toast.error(result.error);
        setOpen(false);
        return;
      }
      if (successMessage) toast.success(successMessage);
      setOpen(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className={cn(triggerFullWidth && "w-full", triggerClassName)}
          />
        }
      >
        {triggerLabel}
      </DialogTrigger>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Annuler</DialogClose>
          <Button variant="destructive" onClick={handleConfirm} disabled={isPending}>
            {isPending ? "Suppression…" : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
