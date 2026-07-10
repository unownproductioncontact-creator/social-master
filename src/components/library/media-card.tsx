"use client";

import Link from "next/link";
import { FileVideo, Info, CircleAlert, TriangleAlert, Check, SquarePen } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { StatusBadge } from "@/components/ui/status-badge";
import { buttonVariants } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ConfirmDeleteButton } from "@/components/ui/confirm-delete-button";
import { deleteMediaAsset } from "@/lib/actions/media";
import {
  checkInstagramReelCompatibility,
  checkInstagramImageCompatibility,
  checkTikTokVideoCompatibility,
} from "@/lib/media-validation";
import { cn } from "@/lib/utils";

/**
 * Données sérialisables d'un média pour la carte. Les URLs publiques sont pré-calculées côté serveur
 * (voir library/page.tsx) car `@/lib/storage` est `server-only` — on n'importe jamais la clé de
 * stockage brute côté client.
 */
export type MediaCardData = {
  id: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  durationSec: number | null;
  mediaUrl: string;
  thumbnailUrl: string | null;
  inUseCount: number;
};

/** Un diagnostic de compatibilité enrichi de la plateforme concernée (pour l'affichage du popover). */
type Diagnostic = { platform: string; level: "error" | "warning"; message: string };

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
}

export function MediaCard({
  asset,
  selectMode = false,
  selected = false,
  onToggleSelect,
}: {
  asset: MediaCardData;
  selectMode?: boolean;
  selected?: boolean;
  onToggleSelect?: (id: string) => void;
}) {
  const isVideo = asset.mimeType.startsWith("video/");
  const meta = {
    mimeType: asset.mimeType,
    sizeBytes: asset.sizeBytes,
    durationSec: asset.durationSec,
    width: asset.width,
    height: asset.height,
  };

  // On conserve les diagnostics détaillés (au lieu de les réduire à un booléen) pour pouvoir les
  // expliquer dans le popover. Chaque source est étiquetée de sa plateforme.
  const diagnostics: Diagnostic[] = isVideo
    ? [
        ...checkInstagramReelCompatibility(meta).map((i) => ({ platform: "Instagram (Reel)", ...i })),
        ...checkTikTokVideoCompatibility(meta).map((i) => ({ platform: "TikTok", ...i })),
      ]
    : checkInstagramImageCompatibility(meta).map((i) => ({ platform: "Instagram", ...i }));
  const hasErrors = diagnostics.some((d) => d.level === "error");

  function toggle() {
    onToggleSelect?.(asset.id);
  }

  return (
    <Card
      className={cn(
        "gap-0 overflow-hidden py-0",
        selectMode && "cursor-pointer transition-shadow hover:ring-1 hover:ring-primary/40",
        selected && "ring-2 ring-primary"
      )}
      {...(selectMode
        ? {
            role: "button" as const,
            tabIndex: 0,
            "aria-pressed": selected,
            onClick: toggle,
            onKeyDown: (e: React.KeyboardEvent) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                toggle();
              }
            },
          }
        : {})}
    >
      <div className="relative flex aspect-square items-center justify-center overflow-hidden bg-[linear-gradient(145deg,#2b2d3a,#4a4d63)] dark:bg-[linear-gradient(145deg,#1c1d26,#33354a)]">
        {isVideo ? (
          asset.thumbnailUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={asset.thumbnailUrl} alt="" className="size-full object-cover" />
          ) : (
            <FileVideo className="size-8 text-white/85" />
          )
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={asset.mediaUrl} alt="" className="size-full object-cover" />
        )}

        {selectMode && (
          <span
            aria-hidden
            className={cn(
              "absolute top-2 right-2 flex size-5 items-center justify-center rounded-md border-2 backdrop-blur transition-colors",
              selected
                ? "border-primary bg-primary text-primary-foreground"
                : "border-white/85 bg-black/25"
            )}
          >
            {selected && <Check className="size-3.5" />}
          </span>
        )}
      </div>

      <CardContent className="space-y-2 py-2.5">
        <div className="flex items-center justify-between text-[11px] text-muted-foreground">
          <span>{formatSize(asset.sizeBytes)}</span>
          {asset.durationSec != null && (
            <span className="tabular-nums">{Math.round(asset.durationSec)}s</span>
          )}
        </div>

        <div className="flex flex-wrap gap-1">
          {hasErrors ? (
            selectMode ? (
              // En mode sélection, tout clic sur la carte doit basculer la sélection : on n'ouvre
              // pas de popover, on rend un badge simple non interactif.
              <StatusBadge tone="err">Incompatible</StatusBadge>
            ) : (
              <Popover>
                <PopoverTrigger
                  render={
                    <button
                      type="button"
                      className="inline-flex items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                    />
                  }
                >
                  <StatusBadge tone="err" className="cursor-pointer gap-1">
                    Incompatible
                    <Info className="size-3" />
                  </StatusBadge>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-64 gap-2">
                  <p className="text-[12.5px] font-semibold text-foreground">
                    Problèmes de compatibilité
                  </p>
                  <ul className="space-y-1.5">
                    {diagnostics.map((d, i) => (
                      <li key={i} className="flex gap-1.5 text-[12px] leading-snug">
                        {d.level === "error" ? (
                          <CircleAlert className="mt-px size-3.5 shrink-0 text-destructive" />
                        ) : (
                          <TriangleAlert className="mt-px size-3.5 shrink-0 text-amber-600 dark:text-amber-500" />
                        )}
                        <span className="text-foreground">
                          <span className="font-medium">{d.platform}</span>{" "}
                          <span className="text-muted-foreground">— {d.message}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </PopoverContent>
              </Popover>
            )
          ) : (
            <StatusBadge tone="ok">Compatible</StatusBadge>
          )}

          {asset.inUseCount > 0 && (
            <StatusBadge tone="muted">
              Utilisé · {asset.inUseCount} post{asset.inUseCount > 1 ? "s" : ""}
            </StatusBadge>
          )}
        </div>

        {!selectMode && (
          <div className="space-y-1">
            <Link
              href={`/composer?media=${asset.id}`}
              className={buttonVariants({ variant: "outline", size: "sm", className: "w-full gap-1.5" })}
            >
              <SquarePen className="size-3.5" />
              Utiliser dans un post
            </Link>
            <ConfirmDeleteButton
              onConfirm={deleteMediaAsset.bind(null, asset.id)}
              title="Supprimer ce média ?"
              description={
                asset.inUseCount > 0
                  ? `Ce média est utilisé par ${asset.inUseCount} post${asset.inUseCount > 1 ? "s" : ""}. Les brouillons et posts programmés concernés seront dé-programmés et supprimés ; les posts déjà publiés restent dans votre historique (le média y est simplement détaché). Le fichier sera ensuite définitivement supprimé de votre stockage.`
                  : "Le fichier sera définitivement supprimé de votre stockage. Cette action est irréversible."
              }
              confirmLabel={asset.inUseCount > 0 ? "Dé-programmer et supprimer" : "Supprimer"}
              successMessage="Média supprimé."
              triggerFullWidth
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
