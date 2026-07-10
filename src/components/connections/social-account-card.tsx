import { Card } from "@/components/ui/card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button, buttonVariants } from "@/components/ui/button";
import { ConfirmDeleteButton } from "@/components/ui/confirm-delete-button";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { PlatformChip } from "@/components/ui/platform-chip";
import { disconnectSocialAccount, verifySocialAccount } from "@/lib/actions/social-accounts";
import type { SocialAccountStatus } from "@/generated/prisma/enums";
import { cn } from "@/lib/utils";

const STATUS_LABELS: Record<SocialAccountStatus, { label: string; tone: StatusTone }> = {
  ACTIVE: { label: "Connecté", tone: "ok" },
  NEEDS_REAUTH: { label: "Reconnexion requise", tone: "err" },
  REVOKED: { label: "Révoqué", tone: "muted" },
};

type ConnectedAccount = {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  status: SocialAccountStatus;
  accountType: string | null;
};

export function SocialAccountCard({
  platformLabel,
  connectUrl,
  account,
}: {
  platformLabel: string;
  connectUrl: string;
  account: ConnectedAccount | null;
}) {
  const platformKey = platformLabel.toUpperCase();

  return (
    <Card className="gap-0 px-4 py-4">
      <div className="flex items-center justify-between gap-2">
        <PlatformChip platform={platformKey} />
        {account && (
          <StatusBadge tone={STATUS_LABELS[account.status].tone}>
            {STATUS_LABELS[account.status].label}
          </StatusBadge>
        )}
      </div>

      {account ? (
        <div className="mt-3 space-y-2">
          <div className="flex items-center justify-between gap-4">
            <div className="flex min-w-0 items-center gap-3">
              <Avatar>
                {account.avatarUrl && <AvatarImage src={account.avatarUrl} alt={account.username} />}
                <AvatarFallback>{account.username.slice(0, 2).toUpperCase()}</AvatarFallback>
              </Avatar>
              <div className="min-w-0">
                <p className="truncate text-[13.5px] font-bold">@{account.username}</p>
                <p className="truncate text-[12.5px] text-muted-foreground">
                  {account.displayName || "—"}
                  {account.accountType && ` · ${account.accountType}`}
                </p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <form
                action={async () => {
                  "use server";
                  await verifySocialAccount(account.id);
                }}
              >
                <Button type="submit" variant="outline" size="sm" className="text-[12.5px]">
                  Vérifier
                </Button>
              </form>
              {/* Relancer le flow OAuth sur un compte existant répare sans perte : le callback fait un
                  upsert (id conservé), tout l'historique de publications reste intact. Mis en avant
                  (variant default) quand une action est nécessaire, discret sinon. */}
              <a
                href={connectUrl}
                className={cn(
                  buttonVariants({ variant: account.status !== "ACTIVE" ? "default" : "outline", size: "sm" }),
                  "text-[12.5px]"
                )}
              >
                Reconnecter
              </a>
              <ConfirmDeleteButton
                onConfirm={disconnectSocialAccount.bind(null, account.id)}
                title={`Déconnecter ${platformLabel} ?`}
                description="Le compte et tout son historique de publications dans Social Master (y compris les posts déjà publiés et leurs liens) seront définitivement supprimés. Pour réparer une connexion expirée, utilisez plutôt “Reconnecter”."
                triggerLabel="Déconnecter"
                confirmLabel="Déconnecter"
                successMessage="Compte déconnecté."
                triggerClassName="text-[12.5px]"
              />
            </div>
          </div>
          {account.status !== "ACTIVE" && (
            <p className="text-[12.5px] text-muted-foreground">
              Reconnexion sans perte : votre historique de publications est conservé.
            </p>
          )}
        </div>
      ) : (
        <div className="mt-3 flex items-center justify-between gap-4">
          <p className="text-[12.5px] text-muted-foreground">Aucun compte connecté</p>
          <a href={connectUrl} className={cn(buttonVariants({ size: "sm" }))}>
            Connecter {platformLabel}
          </a>
        </div>
      )}
    </Card>
  );
}
