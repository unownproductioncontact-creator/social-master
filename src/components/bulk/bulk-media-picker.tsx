"use client";

import { useState } from "react";
import { FileVideo, Plus, Check, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Média disponible dans la médiathèque, résolu côté serveur (URL publique + miniature). */
export type LibraryMedia = {
  id: string;
  name: string;
  url: string;
  thumbnailUrl: string | null;
  mimeType: string;
  isVideo: boolean;
};

/**
 * Sélecteur de médias déjà présents dans la médiathèque : grille repliable ; un clic ajoute le média
 * au lot (le parent gère l'anti-doublon via `pickedIds`). Volontairement simple (pas de recherche) —
 * le volume réel est faible (voir CLAUDE.md §1).
 */
export function BulkMediaPicker({
  media,
  pickedIds,
  onPick,
}: {
  media: LibraryMedia[];
  pickedIds: Set<string>;
  onPick: (media: LibraryMedia) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="space-y-3">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <ChevronDown className={cn("transition-transform", open && "rotate-180")} />
        Ajouter depuis la médiathèque ({media.length})
      </Button>

      {open && (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
          {media.map((m) => {
            const picked = pickedIds.has(m.id);
            return (
              <button
                key={m.id}
                type="button"
                disabled={picked}
                onClick={() => onPick(m)}
                title={m.name}
                className={cn(
                  "group relative flex aspect-square items-center justify-center overflow-hidden rounded-lg border-2 bg-muted transition-colors",
                  picked ? "border-primary opacity-60" : "border-transparent hover:border-border"
                )}
              >
                {m.thumbnailUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={m.thumbnailUrl} alt="" className="size-full object-cover" />
                ) : m.isVideo ? (
                  <FileVideo className="size-6 text-muted-foreground" />
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={m.url} alt="" className="size-full object-cover" />
                )}
                <span
                  className={cn(
                    "absolute inset-0 flex items-center justify-center bg-foreground/40 text-background opacity-0 transition-opacity",
                    picked ? "opacity-100" : "group-hover:opacity-100"
                  )}
                >
                  {picked ? <Check className="size-5" /> : <Plus className="size-5" />}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
