"use client";

import { useState } from "react";
import Link from "next/link";
import { FileVideo, ImageIcon, Copy, Check, X, ExternalLink } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { StatusBadge } from "@/components/ui/status-badge";
import { cn } from "@/lib/utils";

/** État d'une carte vidéo dans le lot. Piloté par le parent (BulkComposer). */
export type BulkCardState = {
  /** Clé React stable (indépendante du mediaAssetId, réutilisé possible). */
  key: string;
  mediaAssetId: string;
  name: string;
  url: string;
  thumbnailUrl: string | null;
  isVideo: boolean;
  caption: string;
  hashtagsText: string;
  platforms: { tiktok: boolean; instagram: boolean };
  /** Horaire de base (mode offset/simultané), chaîne datetime-local. */
  dateTime: string;
  /** Horaires par plateforme (mode custom uniquement), chaînes datetime-local. */
  tiktokTime: string;
  instagramTime: string;
  /** Résultat de programmation ; `idle` tant que le lot n'a pas été soumis. */
  result: BulkCardResult;
};

export type BulkCardResult =
  | { status: "idle" }
  | { status: "scheduled"; postId: string }
  | { status: "failed"; message: string };

export type TimingUiMode = "offset" | "simultaneous" | "custom";

export function BulkCard({
  card,
  index,
  timingMode,
  tiktokConnected,
  instagramConnected,
  disabled,
  onChange,
  onRemove,
}: {
  card: BulkCardState;
  index: number;
  timingMode: TimingUiMode;
  tiktokConnected: boolean;
  instagramConnected: boolean;
  disabled: boolean;
  onChange: (patch: Partial<BulkCardState>) => void;
  onRemove: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const isScheduled = card.result.status === "scheduled";
  const isFailed = card.result.status === "failed";
  // Une carte déjà programmée devient non éditable (voir spec §5).
  const locked = disabled || isScheduled;

  const fullCaption = buildFullCaption(card.caption, card.hashtagsText);

  async function handleCopyCaption() {
    try {
      await navigator.clipboard.writeText(fullCaption);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <Card
      className={cn(
        "overflow-visible",
        isScheduled && "ring-2 ring-primary/40",
        isFailed && "ring-2 ring-destructive/40"
      )}
    >
      <CardContent className="space-y-4">
        {/* En-tête carte : miniature + nom (toujours visibles pour ne jamais confondre deux vidéos) */}
        <div className="flex items-start gap-3">
          <div className="relative flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-muted">
            {card.thumbnailUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={card.thumbnailUrl} alt="" className="size-full object-cover" />
            ) : card.isVideo ? (
              <FileVideo className="size-6 text-muted-foreground" />
            ) : card.url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={card.url} alt="" className="size-full object-cover" />
            ) : (
              <ImageIcon className="size-6 text-muted-foreground" />
            )}
            <span className="absolute left-0 top-0 flex size-5 items-center justify-center rounded-br-md bg-foreground text-[10px] font-semibold text-background">
              {index + 1}
            </span>
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13.5px] font-semibold" title={card.name}>
              {card.name}
            </p>
            <p className="text-[11.5px] text-muted-foreground">
              {card.isVideo ? "Vidéo" : "Image"}
            </p>
            {isScheduled && (
              <StatusBadge tone="scheduled" className="mt-1 gap-1">
                <Check className="size-3" /> Programmé
              </StatusBadge>
            )}
            {isFailed && (
              <StatusBadge tone="err" className="mt-1">
                Échec
              </StatusBadge>
            )}
          </div>
          {!locked && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`Retirer ${card.name}`}
              onClick={onRemove}
            >
              <X className="size-4" />
            </Button>
          )}
        </div>

        {isScheduled ? (
          <div className="flex items-center justify-between rounded-md bg-muted/50 px-3 py-2 text-[13.5px]">
            <span className="text-muted-foreground">Cette vidéo est programmée.</span>
            <Link
              href={`/composer/${card.result.status === "scheduled" ? card.result.postId : ""}`}
              className="inline-flex items-center gap-1 font-semibold text-primary underline-offset-4 hover:underline"
            >
              Voir le post <ExternalLink className="size-3.5" />
            </Link>
          </div>
        ) : (
          <>
            {isFailed && (
              <div className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {card.result.status === "failed" ? card.result.message : ""}
              </div>
            )}

            {/* Légende + bouton Copier (utile en mode brouillon TikTok) */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor={`caption-${card.key}`} className="text-xs font-semibold">
                  Légende
                </Label>
                <div className="flex items-center gap-2">
                  <span className="text-[11.5px] text-muted-foreground">{card.caption.length}/2200</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={handleCopyCaption}
                    aria-label="Copier la légende"
                  >
                    {copied ? <Check className="size-3.5 text-primary" /> : <Copy className="size-3.5" />}
                    {copied ? "Copié" : "Copier"}
                  </Button>
                </div>
              </div>
              <Textarea
                id={`caption-${card.key}`}
                value={card.caption}
                disabled={locked}
                rows={3}
                placeholder="Écrivez votre légende…"
                onChange={(e) => onChange({ caption: e.target.value.slice(0, 2200) })}
              />
            </div>

            {/* Hashtags */}
            <div className="space-y-1.5">
              <Label htmlFor={`hashtags-${card.key}`} className="text-xs font-semibold">
                Hashtags
              </Label>
              <Input
                id={`hashtags-${card.key}`}
                value={card.hashtagsText}
                disabled={locked}
                placeholder="pokemon tcg boosters"
                onChange={(e) => onChange({ hashtagsText: e.target.value })}
              />
            </div>

            {/* Horaires : 1 champ (offset/simultané) ou 2 champs par plateforme (custom) */}
            {timingMode === "custom" ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor={`tiktok-time-${card.key}`} className="text-xs font-semibold">
                    Heure TikTok
                  </Label>
                  <Input
                    id={`tiktok-time-${card.key}`}
                    type="datetime-local"
                    value={card.tiktokTime}
                    disabled={locked || !card.platforms.tiktok}
                    onChange={(e) => onChange({ tiktokTime: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`instagram-time-${card.key}`} className="text-xs font-semibold">
                    Heure Instagram
                  </Label>
                  <Input
                    id={`instagram-time-${card.key}`}
                    type="datetime-local"
                    value={card.instagramTime}
                    disabled={locked || !card.platforms.instagram}
                    onChange={(e) => onChange({ instagramTime: e.target.value })}
                  />
                </div>
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label htmlFor={`date-${card.key}`} className="text-xs font-semibold">
                  Date et heure de publication
                </Label>
                <Input
                  id={`date-${card.key}`}
                  type="datetime-local"
                  value={card.dateTime}
                  disabled={locked}
                  onChange={(e) => onChange({ dateTime: e.target.value })}
                />
                {timingMode === "offset" && card.platforms.tiktok && card.platforms.instagram && (
                  <p className="text-[11.5px] text-muted-foreground">
                    TikTok à cette heure, Instagram 5 min après.
                  </p>
                )}
              </div>
            )}

            {/* Plateformes (les deux cochées par défaut, décochables indépendamment) */}
            <div className="space-y-2">
              <Label className="text-xs font-semibold">Plateformes</Label>
              <div className="flex flex-wrap gap-4">
                <div className="flex items-center gap-2">
                  <Checkbox
                    id={`tiktok-${card.key}`}
                    checked={card.platforms.tiktok}
                    disabled={locked || !tiktokConnected}
                    onCheckedChange={(checked) =>
                      onChange({ platforms: { ...card.platforms, tiktok: checked === true } })
                    }
                  />
                  <Label htmlFor={`tiktok-${card.key}`} className="text-[13.5px] font-normal">
                    TikTok{" "}
                    {!tiktokConnected && <span className="text-muted-foreground">(non connecté)</span>}
                  </Label>
                </div>
                <div className="flex items-center gap-2">
                  <Checkbox
                    id={`instagram-${card.key}`}
                    checked={card.platforms.instagram}
                    disabled={locked || !instagramConnected}
                    onCheckedChange={(checked) =>
                      onChange({ platforms: { ...card.platforms, instagram: checked === true } })
                    }
                  />
                  <Label htmlFor={`instagram-${card.key}`} className="text-[13.5px] font-normal">
                    Instagram{" "}
                    {!instagramConnected && (
                      <span className="text-muted-foreground">(non connecté)</span>
                    )}
                  </Label>
                </div>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** Combine légende + hashtags (préfixés « # ») pour le presse-papiers (comme le composer mono-post). */
export function buildFullCaption(caption: string, hashtagsText: string): string {
  const tags = hashtagsText.trim()
    ? hashtagsText
        .trim()
        .split(/[\s,]+/)
        .filter(Boolean)
        .map((h) => (h.startsWith("#") ? h : `#${h}`))
        .join(" ")
    : "";
  return [caption.trim(), tags].filter(Boolean).join("\n\n");
}
