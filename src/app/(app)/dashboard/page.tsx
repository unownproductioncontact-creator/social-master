import Link from "next/link";
import { format } from "date-fns";
import { verifySession, getCurrentUser } from "@/lib/dal";
import { db } from "@/lib/db";
import { Badge } from "@/components/ui/badge";
import { StatCard } from "@/components/ui/stat-card";
import { PageHeader } from "@/components/layout/page-header";

const PLATFORM_LABELS: Record<string, string> = {
  INSTAGRAM: "Instagram",
  TIKTOK: "TikTok",
};

export default async function DashboardPage() {
  const session = await verifySession();
  const user = await getCurrentUser();

  const in72h = new Date(Date.now() + 72 * 3600 * 1000);

  const [scheduledPosts, accounts, recentFailures] = await Promise.all([
    db.post.findMany({
      where: { userId: session.userId, status: "SCHEDULED", scheduledAt: { lte: in72h, gte: new Date() } },
      include: { postTargets: true },
    }),
    db.socialAccount.findMany({ where: { userId: session.userId } }),
    db.postTarget.findMany({
      where: { post: { userId: session.userId }, status: "FAILED" },
      include: { post: true },
      orderBy: { updatedAt: "desc" },
      take: 5,
    }),
  ]);

  // Tri par l'horaire le plus tôt parmi les cibles (fallback sur Post.scheduledAt si une cible
  // n'a pas encore de scheduledAt propre — posts programmés avant la Vague 1).
  const upcomingPosts = scheduledPosts
    .map((post) => {
      const earliest = post.postTargets.reduce<Date | null>((min, target) => {
        const effective = target.scheduledAt ?? post.scheduledAt;
        if (!effective) return min;
        return !min || effective < min ? effective : min;
      }, null);
      return { post, earliest: earliest ?? post.scheduledAt };
    })
    .sort((a, b) => (a.earliest?.getTime() ?? 0) - (b.earliest?.getTime() ?? 0))
    .slice(0, 5);

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Bonjour${user?.name ? `, ${user.name}` : ""}`}
        description="Voici l’état de votre planificateur."
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard label="Prochaines publications" value={upcomingPosts.length} detail="Sur les 72 prochaines heures">
          {upcomingPosts.length === 0 ? (
            <p className="text-sm text-muted-foreground">Aucune publication programmée pour l’instant.</p>
          ) : (
            upcomingPosts.map(({ post }) => (
              <Link
                key={post.id}
                href={`/composer/${post.id}`}
                className="block rounded-md border p-2 text-sm hover:bg-muted/50"
              >
                <p className="truncate">{post.caption || "(sans légende)"}</p>
                <div className="mt-1 flex flex-wrap gap-1">
                  {post.postTargets.map((target) => {
                    const effective = target.scheduledAt ?? post.scheduledAt;
                    return (
                      <Badge key={target.id} variant="outline" className="font-normal">
                        {PLATFORM_LABELS[target.platform] ?? target.platform}
                        {effective && <span className="tabular-nums"> · {format(effective, "HH:mm")}</span>}
                      </Badge>
                    );
                  })}
                </div>
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
