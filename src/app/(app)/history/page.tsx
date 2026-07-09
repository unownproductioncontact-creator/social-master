import Link from "next/link";
import { format } from "date-fns";
import { verifySession } from "@/lib/dal";
import { db } from "@/lib/db";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/layout/page-header";
import { CopyCaptionButton } from "@/components/history/copy-caption-button";
import { History as HistoryIcon } from "lucide-react";

const STATUS_LABELS: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  PENDING: { label: "En attente", variant: "outline" },
  PROCESSING: { label: "En cours", variant: "secondary" },
  PUBLISHED: { label: "Publié", variant: "default" },
  SENT_TO_INBOX: { label: "Envoyé en brouillon TikTok", variant: "secondary" },
  FAILED: { label: "Échoué", variant: "destructive" },
};

const PLATFORM_LABELS: Record<string, string> = {
  INSTAGRAM: "Instagram",
  TIKTOK: "TikTok",
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
      <PageHeader title="Historique" description="Toutes les publications et le détail des échecs." />

      {targets.length === 0 ? (
        <EmptyState icon={HistoryIcon} title="Aucune publication pour l’instant" />
      ) : (
        <div className="space-y-2">
          {targets.map((target) => {
            const status = STATUS_LABELS[target.status] ?? { label: target.status, variant: "outline" as const };
            const effectiveAt = target.scheduledAt ?? target.post.scheduledAt;
            const isTikTokDraft =
              target.platform === "TIKTOK" &&
              target.publishMode === "TIKTOK_DRAFT" &&
              (target.status === "SENT_TO_INBOX" || target.status === "PUBLISHED");
            return (
              <Card key={target.id} className="transition-colors hover:bg-muted/50">
                <CardContent className="flex items-center justify-between gap-4 py-3">
                  <Link href={`/composer/${target.postId}`} className="min-w-0 flex-1">
                    <p className="truncate text-sm">{target.post.caption || "(sans légende)"}</p>
                    <p className="text-xs text-muted-foreground">
                      {PLATFORM_LABELS[target.platform] ?? target.platform}
                      {effectiveAt && (
                        <>
                          {" "}
                          · programmé <span className="tabular-nums">{format(effectiveAt, "dd/MM/yyyy HH:mm")}</span>
                        </>
                      )}
                      {" "}
                      · mis à jour <span className="tabular-nums">{format(target.updatedAt, "dd/MM/yyyy HH:mm")}</span>
                    </p>
                    {target.errorMessage && (
                      <p className="mt-1 text-xs text-destructive">{target.errorMessage}</p>
                    )}
                  </Link>
                  <div className="flex shrink-0 items-center gap-2">
                    {isTikTokDraft && (
                      <CopyCaptionButton
                        caption={target.post.caption}
                        hashtags={target.post.hashtags}
                        captionOverride={target.captionOverride}
                      />
                    )}
                    <Badge variant={status.variant}>{status.label}</Badge>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
