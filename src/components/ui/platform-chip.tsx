import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

const PLATFORM_LABELS: Record<string, string> = {
  TIKTOK: "TikTok",
  INSTAGRAM: "Instagram",
  YOUTUBE: "YouTube",
};

/** Nom lisible d'une plateforme (TikTok/Instagram/YouTube) ; valeur inconnue renvoyée telle quelle. */
export function platformLabel(platform: string): string {
  return PLATFORM_LABELS[platform] ?? platform;
}

/**
 * Puce plateforme (maquette .chip) : « TikTok · <b>18:00</b> ».
 * 11px semibold, pilule, fond gris clair, bordure forte, heure en gras tabular.
 * Sans `time`, affiche seulement le nom de la plateforme.
 */
export function PlatformChip({
  platform,
  time,
  className,
}: {
  platform: "TIKTOK" | "INSTAGRAM" | string;
  time?: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-input bg-secondary px-2 py-[2.5px] text-[11px] font-semibold text-secondary-foreground",
        className
      )}
    >
      <span>{platformLabel(platform)}</span>
      {time != null && time !== "" && (
        <>
          <span aria-hidden="true" className="text-muted-foreground">
            ·
          </span>
          <b className="font-bold tabular-nums">{time}</b>
        </>
      )}
    </span>
  );
}
