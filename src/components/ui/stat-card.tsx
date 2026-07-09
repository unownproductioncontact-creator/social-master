import type { ReactNode } from "react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/** Ton de coloration du delta (maquette : accent par défaut, vert quand « tout va bien »). */
export type StatDeltaTone = "accent" | "ok" | "muted" | "err";

const DELTA_TONE: Record<StatDeltaTone, string> = {
  accent: "text-primary-strong",
  ok: "text-[#16a34a] dark:text-[#4ade80]",
  muted: "text-muted-foreground",
  err: "text-destructive",
};

/**
 * Carte de statistique (maquette .stat) : libellé 11.5px atténué, valeur 21px bold
 * tabular, delta 11.5px semibold coloré. `detail` et `children` restent supportés
 * (contenu additionnel sous la valeur : liste, note…).
 */
export function StatCard({
  label,
  value,
  delta,
  deltaTone = "accent",
  detail,
  children,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  delta?: ReactNode;
  deltaTone?: StatDeltaTone;
  detail?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn("gap-0 px-3.5", className)}>
      <p className="text-[11.5px] font-medium text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-[21px] leading-tight font-bold tracking-[-0.02em] tabular-nums">
        {value}
      </p>
      {delta != null && (
        <p className={cn("mt-0.5 text-[11.5px] font-semibold", DELTA_TONE[deltaTone])}>{delta}</p>
      )}
      {detail != null && (
        <p className="mt-0.5 text-[11.5px] text-muted-foreground">{detail}</p>
      )}
      {children != null && <div className="mt-3 space-y-2 text-sm">{children}</div>}
    </Card>
  );
}
