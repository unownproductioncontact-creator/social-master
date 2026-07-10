"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Images, ListChecks, Trash2, X } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { EmptyState } from "@/components/ui/empty-state";
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
import { MediaUploader } from "@/components/library/media-uploader";
import { MediaCard, type MediaCardData } from "@/components/library/media-card";
import { deleteMediaAssets } from "@/lib/actions/media";

/**
 * Médiathèque interactive (constat P3-1a/P3-1b) : enveloppe la grille des médias pour gérer le mode
 * sélection multiple (coche par carte + barre d'actions collante) tout en conservant l'affichage
 * carte-par-carte hors mode sélection. La grille était auparavant rendue directement par la page
 * serveur ; les URLs publiques sont pré-calculées côté serveur (voir library/page.tsx).
 */
export function MediaLibrary({ assets }: { assets: MediaCardData[] }) {
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function exitSelectMode() {
    setSelectMode(false);
    setSelected(new Set());
  }

  // On ne garde que les identifiants encore présents dans la liste (un média a pu disparaître après
  // un rafraîchissement serveur).
  const selectedIds = assets.filter((a) => selected.has(a.id)).map((a) => a.id);
  const count = selectedIds.length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Médiathèque"
        description="Toutes vos images et vidéos importées, avec leur compatibilité par plateforme."
        actions={
          assets.length > 0 ? (
            selectMode ? (
              <Button variant="outline" size="sm" onClick={exitSelectMode} className="gap-1.5">
                <X className="size-3.5" />
                Annuler
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setSelectMode(true)}
                className="gap-1.5"
              >
                <ListChecks className="size-3.5" />
                Sélectionner
              </Button>
            )
          ) : null
        }
      />

      <MediaUploader />

      {assets.length > 0 ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {assets.map((asset) => (
            <MediaCard
              key={asset.id}
              asset={asset}
              selectMode={selectMode}
              selected={selected.has(asset.id)}
              onToggleSelect={toggle}
            />
          ))}
        </div>
      ) : (
        <EmptyState icon={Images} title="Aucun média importé pour l’instant" />
      )}

      {selectMode && (
        <div className="sticky bottom-4 z-30 mx-auto flex w-full max-w-md items-center justify-between gap-3 rounded-xl border border-border bg-popover/95 px-4 py-2.5 shadow-lg ring-1 ring-foreground/10 backdrop-blur">
          <span className="text-[13px] font-medium">
            {count} sélectionné{count > 1 ? "s" : ""}
          </span>
          <div className="flex items-center gap-1.5">
            <Button variant="ghost" size="sm" onClick={exitSelectMode}>
              Annuler
            </Button>
            <BulkDeleteButton ids={selectedIds} onDone={exitSelectMode} />
          </div>
        </div>
      )}
    </div>
  );
}

/** Dialog de confirmation + suppression groupée, avec le même avertissement cascade que l'unitaire. */
function BulkDeleteButton({ ids, onDone }: { ids: string[]; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const count = ids.length;

  function handleConfirm() {
    startTransition(async () => {
      const result = await deleteMediaAssets(ids);
      if (result.deleted > 0) {
        toast.success(
          `${result.deleted} média${result.deleted > 1 ? "s" : ""} supprimé${result.deleted > 1 ? "s" : ""}.`
        );
      }
      if (result.errors.length > 0) {
        toast.error(
          result.errors.length === 1
            ? result.errors[0]
            : `${result.errors.length} média(s) n’ont pas pu être supprimés.`
        );
      }
      setOpen(false);
      onDone();
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={<Button variant="destructive" size="sm" disabled={count === 0} className="gap-1.5" />}
      >
        <Trash2 className="size-3.5" />
        Supprimer la sélection
      </DialogTrigger>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>
            Supprimer {count} média{count > 1 ? "s" : ""} ?
          </DialogTitle>
          <DialogDescription>
            Les posts programmés utilisant ces médias seront dé-programmés puis supprimés ; les posts
            déjà publiés sont conservés (le média y est simplement détaché). Les fichiers seront
            définitivement supprimés de votre stockage.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Annuler</DialogClose>
          <Button variant="destructive" onClick={handleConfirm} disabled={isPending}>
            {isPending ? "Suppression…" : "Supprimer"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
