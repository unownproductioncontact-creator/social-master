import type { ReactNode } from "react";

/**
 * En-tête de page standard : titre, description optionnelle, actions optionnelles
 * (boutons alignés à droite). Remplace le bloc h1+p dupliqué dans chaque page.
 */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
      <div className="min-w-0">
        <h1 className="text-[19px] font-semibold tracking-[-0.015em]">{title}</h1>
        {description && (
          <p className="mt-[3px] text-[13px] text-muted-foreground">{description}</p>
        )}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
