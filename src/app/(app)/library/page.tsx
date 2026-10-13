import { verifySession } from "@/lib/dal";
import { db } from "@/lib/db";
import { getPublicMediaUrl } from "@/lib/storage";
import { MediaLibrary } from "@/components/library/media-library";
import type { MediaCardData } from "@/components/library/media-card";
import { daysBeforeUnusedPurge } from "@/lib/media-retention";

export default async function LibraryPage() {
  const session = await verifySession();

  const assets = await db.mediaAsset.findMany({
    where: { userId: session.userId, status: "READY" },
    // Une image servant de miniature YouTube ou de couverture de Reel compte comme utilisée (§37).
    include: { _count: { select: { postMedia: true, coverForTargets: true } } },
    orderBy: { createdAt: "desc" },
  });

  const now = new Date();

  // Les URLs publiques sont calculées ici (serveur) car `@/lib/storage` est `server-only` : la carte
  // cliente ne reçoit que des URLs prêtes, jamais les clés de stockage brutes.
  const cards: MediaCardData[] = assets.map((asset) => ({
    id: asset.id,
    mimeType: asset.mimeType,
    sizeBytes: asset.sizeBytes,
    width: asset.width,
    height: asset.height,
    durationSec: asset.durationSec,
    mediaUrl: getPublicMediaUrl(asset.storageKey),
    thumbnailUrl: asset.thumbnailKey ? getPublicMediaUrl(asset.thumbnailKey) : null,
    inUseCount: asset._count.postMedia,
    coverCount: asset._count.coverForTargets,
    purgeInDays:
      asset._count.postMedia + asset._count.coverForTargets === 0 ? daysBeforeUnusedPurge(asset.createdAt, now) : null,
  }));

  return <MediaLibrary assets={cards} />;
}
