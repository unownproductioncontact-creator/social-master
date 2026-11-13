import { Card } from "@/components/ui/card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button, buttonVariants } from "@/components/ui/button";
import { ConfirmDeleteButton } from "@/components/ui/confirm-delete-button";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { PlatformChip } from "@/components/ui/platform-chip";
import { Input } from "@/components/ui/input";
import { disconnectSocialAccount, renameSocialAccount, verifySocialAccount } from "@/lib/actions/social-accounts";
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
  /** Nom donné par l'utilisateur (« Principal », « Clips »…, §44). */
  label?: string | null;
};

export function SocialAccountCard({
  platformLabel,
  connectUrl,
  account,
  notice,
  multi = false,
  principal = false,
}: {
  platformLabel: string;
  connectUrl: string;
  account: ConnectedAccount | null;
  /** Action recommandée sur un compte actif (ex. autorisation à compléter) : met « Reconnecter » en avant. */
  notice?: string;
  /** Plusieurs comptes sur ce réseau (§44) : nom du compte mis en avant + champ pour le nommer. */
  multi?: boolean;
  /** Compte principal du réseau (le plus ancien) : utilisé quand un post ne précise pas de compte. */
  principal?: boolean;
}) {
  const platformKey = platformLabel.toUpperCase();
  const needsAction = account ? account.status !== "ACTIVE" || Boolean(notice) : false;

  return (
    <Card className="gap-0 px-4 py-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <PlatformChip platform={platformKey} />
          {multi && account?.label && <span className="truncate text-[13px] font-semibold">{account.label}</span>}
          {multi && principal && <StatusBadge tone="muted">Principal</StatusBadge>}
        </div>
        {account && (
          <StatusBadge tone={STATUS_LABELS[account.status].tone}>
            {STATUS_LABELS[account.status].label}
          </StatusBadge>
        )}
      </div>

      {account ? (
        <div className="mt-3 space-y-2">
          {/* Les boutons passent sous le compte quand la carte est étroite : le @pseudo reste lisible. */}
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <div className="flex min-w-[9rem] flex-1 items-center gap-3">
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
                  buttonVariants({ variant: needsAction ? "default" : "outline", size: "sm" }),
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
          {notice && account.status === "ACTIVE" && (
            <p className="text-[12.5px] text-amber-700 dark:text-amber-400">{notice}</p>
          )}
          {multi && (
            // Nom du compte (§44) : c'est ce nom qu'on donne à Claude (« programme sur Clips ») et qu'affiche le composer.
            <form action={renameSocialAccount.bind(null, account.id)} className="flex items-center gap-2">
              <Input
                name="label"
                defaultValue={account.label ?? ""}
                placeholder={principal ? "Nom du compte (ex. Principal)" : "Nom du compte (ex. Clips)"}
                maxLength={40}
                className="h-8 text-[12.5px]"
                aria-label={`Nom du compte ${platformLabel} @${account.username}`}
              />
              <Button type="submit" variant="outline" size="sm" className="shrink-0 text-[12.5px]">
                Nommer
              </Button>
            </form>
          )}
          {needsAction && (
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
