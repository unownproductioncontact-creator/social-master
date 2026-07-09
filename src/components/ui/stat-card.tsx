import type { ReactNode } from "react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * Carte de statistique standard : label, valeur, détail/delta optionnel,
 * avec un emplacement pour du contenu additionnel (liste, etc.).
 */
export function StatCard({
  label,
  value,
  detail,
  delta,
  children,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  detail?: ReactNode;
  delta?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <Card className={className}>
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardTitle className="flex items-baseline gap-2 text-2xl">
          {value}
          {delta && <span className="text-sm font-medium text-primary-strong">{delta}</span>}
        </CardTitle>
        {detail && <CardDescription>{detail}</CardDescription>}
      </CardHeader>
      {children && <CardContent className="space-y-2">{children}</CardContent>}
    </Card>
  );
}
