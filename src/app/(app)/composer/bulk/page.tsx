import { verifySession } from "@/lib/dal";
import { db } from "@/lib/db";
import { getPublicMediaUrl } from "@/lib/storage";
import { getBulkQuotaInfo } from "@/lib/actions/bulk-info";
import { BulkComposer } from "@/components/bulk/bulk-composer";
import { PageHeader } from "@/components/layout/page-header";

/**
 * Page « Publication en masse » (LOT L5) : uploader plusieurs vidéos et tout paramétrer/programmer
 * depuis UNE seule page. Server component : il résout côté serveur les données lourdes (médias prêts,
 * URLs publiques via le proxy, snapshot des quotas) puis délègue toute l'interactivité au composant
 * client `BulkComposer`.
 */

/**
 * Reconstitue un nom lisible depuis la clé de stockage `media/{userId}/{uuid}-{nom_de_fichier}`
 * (voir buildStorageKey). On retire le préfixe UUID pour n'afficher que le nom d'origine « safe ».
 */
function displayNameFromStorageKey(storageKey: string): string {
  const base = storageKey.split("/").pop() ?? storageKey;
  // Le préfixe est un UUID v4 (36 caractères) suivi d'un tiret ; on l'enlève s'il est présent.
  const match = base.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-(.+)$/i);
  return match ? match[1] : base;
}

export default async function BulkComposerPage() {
  const session = await verifySession();

  const [mediaAssets, accounts, quota] = await Promise.all([
    db.mediaAsset.findMany({
      where: { userId: session.userId, status: "READY" },
      orderBy: { createdAt: "desc" },
    }),
    db.socialAccount.findMany({ where: { userId: session.userId }, select: { platform: true } }),
    getBulkQuotaInfo(),
  ]);

  // Le mode masse est pensé pour la vidéo (une vidéo = une publication), mais on autorise aussi les
  // images déjà présentes dans la médiathèque (elles resteront des posts photo valides). On expose
  // tous les médias READY ; l'UI distingue vidéo/image par `isVideo`.
  const libraryMedia = mediaAssets.map((m) => ({
    id: m.id,
    name: displayNameFromStorageKey(m.storageKey),
    url: getPublicMediaUrl(m.storageKey),
    thumbnailUrl: m.thumbnailKey ? getPublicMediaUrl(m.thumbnailKey) : null,
    mimeType: m.mimeType,
    isVideo: m.mimeType.startsWith("video/"),
  }));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Publication en masse"
        description="Importez plusieurs vidéos, réglez légende, hashtags, horaires et plateformes pour tout le lot, puis programmez d'un coup."
      />

      <BulkComposer
        libraryMedia={libraryMedia}
        instagramConnected={accounts.some((a) => a.platform === "INSTAGRAM")}
        tiktokConnected={accounts.some((a) => a.platform === "TIKTOK")}
        initialQuota={quota}
      />
    </div>
  );
}
