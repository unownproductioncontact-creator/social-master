import Link from "next/link";
import { format } from "date-fns";
import { verifySession } from "@/lib/dal";
import { db } from "@/lib/db";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";

const STATUS_LABELS: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  PENDING: { label: "En attente", variant: "outline" },
  PROCESSING: { label: "En cours", variant: "secondary" },
  PUBLISHED: { label: "Publié", variant: "default" },
  SENT_TO_INBOX: { label: "Envoyé en brouillon TikTok", variant: "secondary" },
  FAILED: { label: "Échoué", variant: "destructive" },
};

export default async function HistoryPage() {
  const session = await verifySession();

  const targets = await db.postTarget.findMany({
    where: { post: { userId: session.userId } },
    include: { post: true },
    orderBy: { updatedAt: "desc" },
    take: 50,
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Historique</h1>
        <p className="text-muted-foreground">Toutes les publications et le détail des échecs.</p>
      </div>

      {targets.length === 0 ? (
        <p className="text-sm text-muted-foreground">Aucune publication pour l’instant.</p>
      ) : (
        <div className="space-y-2">
          {targets.map((target) => {
            const status = STATUS_LABELS[target.status] ?? { label: target.status, variant: "outline" as const };
            return (
              <Link key={target.id} href={`/composer/${target.postId}`}>
                <Card className="transition-colors hover:bg-muted/50">
                  <CardContent className="flex items-center justify-between gap-4 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm">{target.post.caption || "(sans légende)"}</p>
                      <p className="text-xs text-muted-foreground">
                        {target.platform} · {format(target.updatedAt, "dd/MM/yyyy HH:mm")}
                      </p>
                      {target.errorMessage && (
                        <p className="mt-1 text-xs text-destructive">{target.errorMessage}</p>
                      )}
                    </div>
                    <Badge variant={status.variant}>{status.label}</Badge>
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
