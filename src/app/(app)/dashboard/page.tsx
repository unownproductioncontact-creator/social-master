import Link from "next/link";
import { format } from "date-fns";
import { verifySession, getCurrentUser } from "@/lib/dal";
import { db } from "@/lib/db";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

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
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Bonjour{user?.name ? `, ${user.name}` : ""} 👋
        </h1>
        <p className="text-muted-foreground">Voici l’état de votre planificateur.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Prochaines publications</CardTitle>
            <CardDescription>Sur les 72 prochaines heures</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
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
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Connexions</CardTitle>
            <CardDescription>Instagram et TikTok</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {accounts.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Aucun compte connecté. Rendez-vous dans{" "}
                <Link href="/connections" className="font-medium text-foreground underline underline-offset-4">
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
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Derniers échecs</CardTitle>
            <CardDescription>À corriger en priorité</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
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
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
