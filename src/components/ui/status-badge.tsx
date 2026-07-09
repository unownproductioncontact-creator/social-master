import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Tonalités de statut de la maquette (.badge). */
export type StatusTone = "scheduled" | "ok" | "err" | "muted" | "warn";

const TONE_CLASSES: Record<StatusTone, string> = {
  // Programmé : fond accent-soft, texte accent, bordure accent-border
  scheduled:
    "bg-accent-strong text-primary-strong border border-accent-border",
  // Publié : vert sur fond vert clair
  ok: "bg-[#e8f7ee] text-[#16a34a] border border-transparent dark:bg-[#16a34a]/15 dark:text-[#4ade80]",
  // Échec : rouge sur fond rouge clair
  err: "bg-[#fdecec] text-[#dc2626] border border-transparent dark:bg-[#dc2626]/15 dark:text-[#f87171]",
  // Brouillon / neutre : gris lisible (contraste AA sur fond clair), bordure forte
  muted:
    "bg-secondary text-secondary-foreground border border-input",
  // Avertissement / en cours : ambre
  warn: "bg-[#fef6e7] text-[#b45309] border border-transparent dark:bg-[#f59e0b]/15 dark:text-[#fbbf24]",
};

/**
 * Badge de statut (maquette .badge) : 11px semibold, padding 3px 9px, pilule.
 * `tone` choisit la palette ; `children` porte le libellé (français).
 */
export function StatusBadge({
  tone,
  children,
  className,
}: {
  tone: StatusTone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center whitespace-nowrap rounded-full px-[9px] py-[3px] text-[11px] font-semibold leading-none",
        TONE_CLASSES[tone],
        className
      )}
    >
      {children}
    </span>
  );
}

/**
 * Tonalité pour un statut Post (DRAFT/SCHEDULED/PARTIALLY_PUBLISHED/PUBLISHED/FAILED)
 * ou PostTarget (PENDING/PROCESSING/PUBLISHED/SENT_TO_INBOX/FAILED).
 * Tout statut inconnu retombe sur « muted ».
 */
export function postStatusTone(status: string): StatusTone {
  switch (status) {
    case "SCHEDULED":
      return "scheduled";
    case "PENDING":
    case "PROCESSING":
      return "warn";
    case "PUBLISHED":
    case "SENT_TO_INBOX":
      return "ok";
    case "PARTIALLY_PUBLISHED":
      // succès partiel : ambre pour signaler qu'une action reste possible
      return "warn";
    case "FAILED":
      return "err";
    case "DRAFT":
    default:
      return "muted";
  }
}

/** Libellé français d'un statut Post ou PostTarget. Statut inconnu → renvoyé tel quel. */
export function postStatusLabel(status: string): string {
  switch (status) {
    // PostStatus
    case "DRAFT":
      return "Brouillon";
    case "SCHEDULED":
      return "Programmé";
    case "PARTIALLY_PUBLISHED":
      return "Partiellement publié";
    case "PUBLISHED":
      return "Publié";
    case "FAILED":
      return "Échec";
    // PostTargetStatus (spécifiques)
    case "PENDING":
      return "En attente";
    case "PROCESSING":
      return "En cours";
    case "SENT_TO_INBOX":
      return "Envoyé en brouillon";
    default:
      return status;
  }
}
