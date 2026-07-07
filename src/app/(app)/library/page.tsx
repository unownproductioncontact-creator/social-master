import { verifySession } from "@/lib/dal";
import { db } from "@/lib/db";
import { MediaUploader } from "@/components/library/media-uploader";
import { MediaCard } from "@/components/library/media-card";

export default async function LibraryPage() {
  const session = await verifySession();

  const assets = await db.mediaAsset.findMany({
    where: { userId: session.userId, status: "READY" },
    orderBy: { createdAt: "desc" },
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Médiathèque</h1>
        <p className="text-muted-foreground">
          Toutes vos images et vidéos importées, avec leur compatibilité par plateforme.
        </p>
      </div>

      <MediaUploader />

      {assets.length > 0 ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
          {assets.map((asset) => (
            <MediaCard key={asset.id} asset={asset} />
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Aucun média importé pour l’instant.</p>
      )}
    </div>
  );
}
