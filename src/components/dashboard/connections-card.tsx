import Link from "next/link";
import { Card } from "@/components/ui/card";
import { PlatformChip } from "@/components/ui/platform-chip";
import { StatusBadge } from "@/components/ui/status-badge";
import { cn } from "@/lib/utils";

type ConnectionAccount = {
  id: string;
  platform: string;
  username: string;
  status: string;
};

/** Les deux plateformes gérées, dans l'ordre d'affichage. */
const PLATFORMS: Array<"INSTAGRAM" | "TIKTOK"> = ["INSTAGRAM", "TIKTOK"];

/**
 * Carte compacte « Connexions » (colonne droite de la maquette). Une ligne dense par plateforme :
 * PlatformChip + @handle + badge de statut (Connecté / Reconnexion requise / Non connecté).
 * Une plateforme non connectée renvoie vers /connections ; une plateforme connectée mais qui
 * nécessite une action (Reconnexion requise / Révoqué) rend toute la ligne cliquable vers /connections
 * (le badge seul était auparavant inerte).
 */
export function ConnectionsCard({ accounts }: { accounts: ConnectionAccount[] }) {
  return (
    <Card className="gap-0 py-0">
      <h3 className="border-b border-border px-[15px] py-3 text-[13.5px] font-semibold">
        Connexions
      </h3>
      <div className="flex flex-col">
        {PLATFORMS.map((platform) => {
          const account = accounts.find((a) => a.platform === platform);
          const needsAction = account != null && account.status !== "ACTIVE";
          const rowClassName =
            "flex items-center justify-between gap-3 border-b border-border px-[15px] py-[11px] last:border-b-0";

          const left = (
            <div className="flex min-w-0 items-center gap-2">
              <PlatformChip platform={platform} />
              {account ? (
                <span className="truncate text-[12.5px] text-secondary-foreground">
                  @{account.username}
                </span>
              ) : (
                <Link
                  href="/connections"
                  className="text-[12.5px] font-medium text-primary-strong hover:underline"
                >
                  Connecter
                </Link>
              )}
            </div>
          );

          const right = account ? (
            account.status === "ACTIVE" ? (
              <StatusBadge tone="ok">Connecté</StatusBadge>
            ) : account.status === "REVOKED" ? (
              <StatusBadge tone="muted">Révoqué</StatusBadge>
            ) : (
              <StatusBadge tone="err">Reconnexion requise</StatusBadge>
            )
          ) : (
            <StatusBadge tone="muted">Non connecté</StatusBadge>
          );

          if (needsAction) {
            return (
              <Link
                key={platform}
                href="/connections"
                className={cn(rowClassName, "transition-colors hover:bg-muted/50")}
              >
                {left}
                {right}
              </Link>
            );
          }

          return (
            <div key={platform} className={rowClassName}>
              {left}
              {right}
            </div>
          );
        })}
      </div>
    </Card>
  );
}
