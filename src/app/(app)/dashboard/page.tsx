import Link from "next/link";
import { format } from "date-fns";
import { verifySession, getCurrentUser } from "@/lib/dal";
import { db } from "@/lib/db";
import { Badge } from "@/components/ui/badge";
import { StatCard } from "@/components/ui/stat-card";
import { PageHeader } from "@/components/layout/page-header";

export default async function DashboardPage() {
  const session = await verifySession();
  const user = await getCurrentUser();

  const in72h = new Date(Date.now() + 72 * 3600 * 1000);

  const [upcomingTargets, accounts, recentFailures] = await Promise.all([
    db.postTarget.findMany({
      where: { post: { userId: session.userId, status: "SCHEDULED", scheduledAt: { lte: in72h, gte: new Date() } } },
      include: { post: true },
      orderBy: { post: { scheduledAt: "asc" } },
      take: 5,
    }),
    db.socialAccount.findMany({ where: { userId: session.userId } }),
    db.postTarget.findMany({
      where: { post: { userId: session.userId }, status: "FAILED" },
      include: { post: true },
      orderBy: { updatedAt: "desc" },
      take: 5,
    }),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Bonjour${user?.name ? `, ${user.name}` : ""}`}
        description="Voici l’état de votre planificateur."
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard label="Prochaines publications" value={upcomingTargets.length} detail="Sur les 72 prochaines heures">
          {upcomingTargets.length === 0 ? (
            <p className="text-sm text-muted-foreground">Aucune publication programmée pour l’instant.</p>
          ) : (
            upcomingTargets.map((target) => (
              <Link
                key={target.id}
                href={`/composer/${target.postId}`}
                className="block rounded-md border p-2 text-sm hover:bg-muted/50"
              >
                <p className="truncate">{target.post.caption || "(sans légende)"}</p>
                <p className="text-xs text-muted-foreground">
                  {target.platform} · {target.post.scheduledAt ? format(target.post.scheduledAt, "dd/MM HH:mm") : ""}
                </p>
              </Link>
            ))
          )}
        </StatCard>

        <StatCard label="Connexions" value={accounts.length} detail="Instagram et TikTok">
          {accounts.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Aucun compte connecté. Rendez-vous dans{" "}
              <Link href="/connections" className="font-medium text-primary underline underline-offset-4">
                Connexions
              </Link>
              .
            </p>
          ) : (
            accounts.map((account) => (
              <div key={account.id} className="flex items-center justify-between text-sm">
                <span>
                  {account.platform} · @{account.username}
                </span>
                <Badge variant={account.status === "ACTIVE" ? "secondary" : "destructive"}>
                  {account.status === "ACTIVE" ? "Connecté" : "Reconnexion requise"}
                </Badge>
              </div>
            ))
          )}
        </StatCard>

        <StatCard label="Derniers échecs" value={recentFailures.length} detail="À corriger en priorité">
          {recentFailures.length === 0 ? (
            <p className="text-sm text-muted-foreground">Aucun échec récent.</p>
          ) : (
            recentFailures.map((target) => (
              <Link
                key={target.id}
                href={`/composer/${target.postId}`}
                className="block rounded-md border border-destructive/30 bg-destructive/5 p-2 text-sm hover:bg-destructive/10"
              >
                <p className="truncate">{target.post.caption || "(sans légende)"}</p>
                <p className="text-xs text-destructive">
                  {target.platform} : {target.errorMessage}
                </p>
              </Link>
            ))
          )}
        </StatCard>
      </div>
    </div>
  );
}
