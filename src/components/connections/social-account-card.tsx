import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { disconnectSocialAccount, verifySocialAccount } from "@/lib/actions/social-accounts";
import type { SocialAccountStatus } from "@/generated/prisma/enums";

const STATUS_LABELS: Record<SocialAccountStatus, { label: string; variant: "default" | "secondary" | "destructive" }> = {
  ACTIVE: { label: "Connecté", variant: "default" },
  NEEDS_REAUTH: { label: "Reconnexion requise", variant: "destructive" },
  REVOKED: { label: "Révoqué", variant: "secondary" },
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
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{platformLabel}</CardTitle>
        <CardDescription>
          {account ? `@${account.username}` : "Aucun compte connecté"}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {account ? (
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <Avatar>
                {account.avatarUrl && <AvatarImage src={account.avatarUrl} alt={account.username} />}
                <AvatarFallback>{account.username.slice(0, 2).toUpperCase()}</AvatarFallback>
              </Avatar>
              <div>
                <p className="text-sm font-medium">{account.displayName || account.username}</p>
                <div className="mt-1 flex items-center gap-2">
                  <Badge variant={STATUS_LABELS[account.status].variant}>
                    {STATUS_LABELS[account.status].label}
                  </Badge>
                  {account.accountType && (
                    <Badge variant="outline">{account.accountType}</Badge>
                  )}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-1">
              <form
                action={async () => {
                  "use server";
                  await verifySocialAccount(account.id);
                }}
              >
                <Button type="submit" variant="ghost" size="sm">
                  Vérifier
                </Button>
              </form>
              <form
                action={async () => {
                  "use server";
                  await disconnectSocialAccount(account.id);
                }}
              >
                <Button type="submit" variant="ghost" size="sm">
                  Déconnecter
                </Button>
              </form>
            </div>
          </div>
        ) : (
          <a href={connectUrl} className={buttonVariants({ size: "sm" })}>
            Connecter {platformLabel}
          </a>
        )}
      </CardContent>
    </Card>
  );
}
