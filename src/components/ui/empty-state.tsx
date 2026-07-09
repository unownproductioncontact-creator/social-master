import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * État vide standard : icône, titre, description, action optionnelle.
 * À utiliser à la place des paragraphes "Aucun X pour l'instant" ad hoc.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon: LucideIcon;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2.5 rounded-lg border border-dashed border-border px-6 py-9 text-center",
        className
      )}
    >
      <div className="flex size-9 items-center justify-center rounded-full bg-accent-strong text-primary-strong">
        <Icon className="size-[18px]" />
      </div>
      <div className="space-y-1">
        <p className="text-[13.5px] font-semibold">{title}</p>
        {description && (
          <p className="text-[12.5px] text-muted-foreground">{description}</p>
        )}
      </div>
      {action}
    </div>
  );
}
