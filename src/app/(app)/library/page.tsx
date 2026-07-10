import { verifySession } from "@/lib/dal";
import { db } from "@/lib/db";
import { getPublicMediaUrl } from "@/lib/storage";
import { MediaLibrary } from "@/components/library/media-library";
import type { MediaCardData } from "@/components/library/media-card";

export default async function LibraryPage() {
  const session = await verifySession();

  const assets = await db.mediaAsset.findMany({
    where: { userId: session.userId, status: "READY" },
    include: { _count: { select: { postMedia: true } } },
    orderBy: { createdAt: "desc" },
  });

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
  }));

  return <MediaLibrary assets={cards} />;
}
