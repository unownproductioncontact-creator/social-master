import Link from "next/link";
import { formatInTimeZone } from "date-fns-tz";
import { verifySession, getCurrentUser } from "@/lib/dal";
import { db } from "@/lib/db";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/layout/page-header";
import { StatusBadge, postStatusTone, postStatusLabel } from "@/components/ui/status-badge";
import { PlatformChip } from "@/components/ui/platform-chip";
import { CopyCaptionButton } from "@/components/history/copy-caption-button";
import { getPublicMediaUrl } from "@/lib/storage";
import { History as HistoryIcon } from "lucide-react";

export default async function HistoryPage() {
  const session = await verifySession();
  const user = await getCurrentUser();
  const timezone = user?.timezone ?? "Europe/Paris";

  const targets = await db.postTarget.findMany({
    where: { post: { userId: session.userId } },
    include: {
      post: {
        include: {
          postMedia: {
            orderBy: { position: "asc" },
            take: 1,
            include: { mediaAsset: true },
          },
        },
      },
    },
    orderBy: { updatedAt: "desc" },
    take: 50,
  });

  return (
    <div className="space-y-4">
      <PageHeader title="Historique" description="Toutes les publications et le détail des échecs." />

      {targets.length === 0 ? (
        <EmptyState icon={HistoryIcon} title="Aucune publication pour l’instant" />
      ) : (
        <Card className="gap-0 py-0">
          <div className="flex flex-col">
            {targets.map((target) => {
              const effectiveAt = target.scheduledAt ?? target.post.scheduledAt;
              const isTikTokDraft =
                target.platform === "TIKTOK" &&
                target.publishMode === "TIKTOK_DRAFT" &&
                (target.status === "SENT_TO_INBOX" || target.status === "PUBLISHED");
              const firstMedia = target.post.postMedia[0]?.mediaAsset;
              const thumbKey = firstMedia
                ? firstMedia.thumbnailKey ?? (firstMedia.mimeType.startsWith("image/") ? firstMedia.storageKey : null)
                : null;

              return (
                <div
                  key={target.id}
                  className="flex items-center gap-3 border-b border-border px-[15px] py-[11px] last:border-b-0 hover:bg-muted/40"
                >
                  <Link href={`/composer/${target.postId}`} className="flex min-w-0 flex-1 items-center gap-3">
                    {thumbKey ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={getPublicMediaUrl(thumbKey)}
                        alt=""
                        className="size-11 shrink-0 rounded-lg object-cover"
                      />
                    ) : (
                      <span
                        className="relative size-11 shrink-0 rounded-lg"
                        style={{ background: "linear-gradient(145deg,#2b2d3a,#4a4d63)" }}
                      >
                        <span
                          className="absolute top-1/2 left-1/2 -translate-y-1/2 translate-x-[calc(-50%+1px)]"
                          style={{
                            width: 0,
                            height: 0,
                            borderTop: "6px solid transparent",
                            borderBottom: "6px solid transparent",
                            borderLeft: "9px solid rgba(255,255,255,.92)",
                          }}
                        />
                      </span>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13.5px] font-semibold">
                        {target.post.caption || "(sans légende)"}
                      </p>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        <PlatformChip
                          platform={target.platform}
                          time={effectiveAt ? formatInTimeZone(effectiveAt, timezone, "dd/MM HH:mm") : undefined}
                        />
                        <span className="text-[11px] text-muted-foreground">
                          mis à jour {formatInTimeZone(target.updatedAt, timezone, "dd/MM HH:mm")}
                        </span>
                      </div>
                      {target.errorMessage && (
                        <p className="mt-1 text-[12.5px] text-destructive">{target.errorMessage}</p>
                      )}
                    </div>
                  </Link>
                  <div className="flex shrink-0 items-center gap-2">
                    {isTikTokDraft && (
                      <CopyCaptionButton
                        caption={target.post.caption}
                        hashtags={target.post.hashtags}
                        captionOverride={target.captionOverride}
                      />
                    )}
                    <StatusBadge tone={postStatusTone(target.status)}>
                      {postStatusLabel(target.status)}
                    </StatusBadge>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}
    </div>
  );
}
