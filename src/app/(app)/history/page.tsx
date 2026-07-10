import Link from "next/link";
import { formatInTimeZone } from "date-fns-tz";
import { verifySession, getCurrentUser } from "@/lib/dal";
import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/layout/page-header";
import { StatusBadge, postStatusTone, postStatusLabel } from "@/components/ui/status-badge";
import { PlatformChip } from "@/components/ui/platform-chip";
import { CopyCaptionButton } from "@/components/history/copy-caption-button";
import { buttonVariants } from "@/components/ui/button";
import { AutoRefresh } from "@/components/util/auto-refresh";
import { getPublicMediaUrl } from "@/lib/storage";
import { History as HistoryIcon, Info } from "lucide-react";

/**
 * Valeurs de filtre (P2-3b) — CONTRAT INTER-PAGES : ces trois chaînes exactes sont utilisées par
 * d'autres pages pour lier vers un sous-ensemble de l'Historique (ex. la stat « Échecs à corriger »
 * du dashboard vers `/history?filter=failed`). Ne jamais renommer sans mettre à jour les appelants.
 */
type HistoryFilter = "upcoming" | "failed" | "tiktok";

const FILTER_OPTIONS: { value: HistoryFilter | undefined; label: string }[] = [
  { value: undefined, label: "Tous" },
  { value: "upcoming", label: "À venir" },
  { value: "failed", label: "Échecs" },
  { value: "tiktok", label: "TikTok à finaliser" },
];

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 300;

function parseFilter(raw: string | undefined): HistoryFilter | undefined {
  return raw === "upcoming" || raw === "failed" || raw === "tiktok" ? raw : undefined;
}

/** Palier suivant pour « Afficher plus » : 50 → 100, puis +50 à chaque clic, plafonné à 300. */
function nextLimit(current: number): number {
  return current < 100 ? 100 : Math.min(current + 50, MAX_LIMIT);
}

/** Construit `/history?...` en ne portant que les paramètres non-défaut (filtre actif, limite ≠ 50). */
function historyHref(filter: HistoryFilter | undefined, limit?: number): string {
  const params = new URLSearchParams();
  if (filter) params.set("filter", filter);
  if (limit && limit !== DEFAULT_LIMIT) params.set("limit", String(limit));
  const qs = params.toString();
  return qs ? `/history?${qs}` : "/history";
}

export default async function HistoryPage(props: PageProps<"/history">) {
  const session = await verifySession();
  const user = await getCurrentUser();
  const timezone = user?.timezone ?? "Europe/Paris";

  const searchParams = await props.searchParams;
  const rawFilter = Array.isArray(searchParams.filter) ? searchParams.filter[0] : searchParams.filter;
  const rawLimit = Array.isArray(searchParams.limit) ? searchParams.limit[0] : searchParams.limit;
  const filter = parseFilter(rawFilter);
  const parsedLimit = rawLimit ? Number.parseInt(rawLimit, 10) : NaN;
  const limit =
    Number.isFinite(parsedLimit) && parsedLimit > DEFAULT_LIMIT
      ? Math.min(parsedLimit, MAX_LIMIT)
      : DEFAULT_LIMIT;

  // Horaire effectif d'une cible = target.scheduledAt ?? post.scheduledAt (voir dashboard/scheduler) —
  // « à venir » compare cette valeur coalescée à maintenant, d'où le OR ci-dessous.
  const now = new Date();
  const where: Prisma.PostTargetWhereInput = { post: { userId: session.userId } };
  if (filter === "upcoming") {
    where.status = { in: ["PENDING", "PROCESSING"] };
    where.OR = [{ scheduledAt: { gte: now } }, { scheduledAt: null, post: { scheduledAt: { gte: now } } }];
  } else if (filter === "failed") {
    where.status = "FAILED";
  } else if (filter === "tiktok") {
    where.platform = "TIKTOK";
    where.status = "SENT_TO_INBOX";
  }

  const targets = await db.postTarget.findMany({
    where,
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
    take: limit,
  });

  const showMore = targets.length === limit && limit < MAX_LIMIT;

  return (
    <div className="space-y-4">
      <AutoRefresh />
      <PageHeader title="Historique" description="Toutes les publications et le détail des échecs." />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1.5">
          {FILTER_OPTIONS.map((option) => {
            const active = filter === option.value;
            return (
              <Link
                key={option.value ?? "all"}
                href={historyHref(option.value)}
                aria-current={active ? "page" : undefined}
                className={buttonVariants({ variant: active ? "default" : "outline", size: "sm" })}
              >
                {option.label}
              </Link>
            );
          })}
        </div>
        <p className="text-[12px] text-muted-foreground">
          {targets.length} résultat{targets.length !== 1 ? "s" : ""}
        </p>
      </div>

      {filter === "tiktok" && targets.length > 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2.5 text-[12.5px] text-muted-foreground">
          <Info className="mt-0.5 size-4 shrink-0" />
          <p>La vidéo vous attend dans les notifications de l’app TikTok — collez-y la légende copiée.</p>
        </div>
      )}

      {targets.length === 0 ? (
        <EmptyState
          icon={HistoryIcon}
          title={filter ? "Aucun résultat pour ce filtre" : "Aucune publication pour l’instant"}
          action={
            filter ? (
              <Link href="/history" className={buttonVariants({ size: "sm" })}>
                Afficher tout l’historique
              </Link>
            ) : undefined
          }
        />
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

      {showMore && (
        <div className="flex justify-center">
          <Link
            href={historyHref(filter, nextLimit(limit))}
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            Afficher plus
          </Link>
        </div>
      )}
    </div>
  );
}
