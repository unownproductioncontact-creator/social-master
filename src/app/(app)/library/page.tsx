import { verifySession } from "@/lib/dal";
import { db } from "@/lib/db";
import { MediaUploader } from "@/components/library/media-uploader";
import { MediaCard } from "@/components/library/media-card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/layout/page-header";
import { Images } from "lucide-react";

export default async function LibraryPage() {
  const session = await verifySession();

  const assets = await db.mediaAsset.findMany({
    where: { userId: session.userId, status: "READY" },
    include: { _count: { select: { postMedia: true } } },
    orderBy: { createdAt: "desc" },
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Médiathèque"
        description="Toutes vos images et vidéos importées, avec leur compatibilité par plateforme."
      />

      <MediaUploader />

      {assets.length > 0 ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {assets.map((asset) => (
            <MediaCard key={asset.id} asset={asset} inUseCount={asset._count.postMedia} />
          ))}
        </div>
      ) : (
        <EmptyState icon={Images} title="Aucun média importé pour l’instant" />
      )}
    </div>
  );
}
