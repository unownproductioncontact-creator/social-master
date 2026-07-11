import Link from "next/link";
import { Layers } from "lucide-react";
import { formatInTimeZone } from "date-fns-tz";
import { verifySession, getCurrentUser } from "@/lib/dal";
import { db } from "@/lib/db";
import { getPublicMediaUrl } from "@/lib/storage";
import { PostComposerForm } from "@/components/composer/post-composer-form";
import { Card, CardContent } from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";
import { PageHeader } from "@/components/layout/page-header";

/**
 * Reconstitue un nom lisible depuis la clé de stockage `media/{userId}/{uuid}-{nom_de_fichier}`
 * (voir buildStorageKey). Recopié localement depuis composer/bulk/page.tsx (fichier non modifiable).
 */
function displayNameFromStorageKey(storageKey: string): string {
  const base = storageKey.split("/").pop() ?? storageKey;
  const match = base.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-(.+)$/i);
  return match ? match[1] : base;
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Défaut du champ de programmation : DEMAIN 18:00, ou {?date}T18:00 si un jour valide est fourni. */
function defaultScheduleLocal(timezone: string, dateParam: string | undefined): string {
  if (dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
    return `${dateParam}T18:00`;
  }
  const today = formatInTimeZone(new Date(), timezone, "yyyy-MM-dd");
  const [year, month, day] = today.split("-").map(Number);
  const dt = new Date(Date.UTC(year, month - 1, day));
  dt.setUTCDate(dt.getUTCDate() + 1);
  return `${dt.toISOString().slice(0, 10)}T18:00`;
}

export default async function ComposerPage(props: PageProps<"/composer">) {
  const session = await verifySession();
  const searchParams = await props.searchParams;
  const mediaParam = first(searchParams.media);
  const dateParam = first(searchParams.date);
  const duplicateParam = first(searchParams.duplicate);

  const user = await getCurrentUser();
  const timezone = user?.timezone ?? "Europe/Paris";

  const [mediaAssets, accounts, drafts] = await Promise.all([
    db.mediaAsset.findMany({ where: { userId: session.userId, status: "READY" }, orderBy: { createdAt: "desc" } }),
    db.socialAccount.findMany({ where: { userId: session.userId } }),
    db.post.findMany({
      where: { userId: session.userId, status: "DRAFT" },
      orderBy: { updatedAt: "desc" },
      take: 10,
    }),
  ]);

  const mediaOptions = mediaAssets.map((m) => ({
    id: m.id,
    url: getPublicMediaUrl(m.storageKey),
    thumbnailUrl: m.thumbnailKey ? getPublicMediaUrl(m.thumbnailKey) : null,
    name: displayNameFromStorageKey(m.storageKey),
    mimeType: m.mimeType,
    isVideo: m.mimeType.startsWith("video/"),
    // Métadonnées pour les avertissements de compatibilité YouTube Short (durée/format).
    durationSec: m.durationSec,
    width: m.width,
    height: m.height,
    sizeBytes: m.sizeBytes,
  }));

  // Pré-remplissage d'un NOUVEAU brouillon (jamais une édition du post source) :
  //  - ?duplicate={postId} : recopie légende/hashtags/médias/plateformes d'un post existant (scopé userId) ;
  //  - ?media={id} : pré-sélectionne ce média.
  const readyIds = new Set(mediaAssets.map((m) => m.id));
  let initialPost: React.ComponentProps<typeof PostComposerForm>["initialPost"];

  if (duplicateParam) {
    const source = await db.post.findUnique({
      where: { id: duplicateParam },
      include: { postMedia: true, postTargets: true },
    });
    if (source && source.userId === session.userId) {
      const igTarget = source.postTargets.find((t) => t.platform === "INSTAGRAM");
      const ytTarget = source.postTargets.find((t) => t.platform === "YOUTUBE");
      initialPost = {
        caption: source.caption,
        hashtags: source.hashtags,
        mediaAssetIds: source.postMedia
          .slice()
          .sort((a, b) => a.position - b.position)
          .map((pm) => pm.mediaAssetId)
          .filter((id) => readyIds.has(id)),
        targetInstagram: source.postTargets.some((t) => t.platform === "INSTAGRAM"),
        targetInstagramStory: source.postTargets.some((t) => t.platform === "INSTAGRAM" && t.contentType === "STORY"),
        targetTiktok: source.postTargets.some((t) => t.platform === "TIKTOK"),
        targetYoutube: source.postTargets.some((t) => t.platform === "YOUTUBE"),
        youtubeTitle: (ytTarget?.platformOptions as { title?: string } | null)?.title ?? undefined,
        instagramCoverTimeMs:
          (igTarget?.platformOptions as { coverTimeMs?: number } | null)?.coverTimeMs ?? null,
      };
    }
  } else if (mediaParam && readyIds.has(mediaParam)) {
    initialPost = { mediaAssetIds: [mediaParam] };
  }

  return (
    <div className="space-y-8">
      <PageHeader
        title="Créer un post"
        description="Média, légende, hashtags et prévisualisation par plateforme."
        actions={
          <Link
            href="/composer/bulk"
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            <Layers />
            Publication en masse
          </Link>
        }
      />

      <PostComposerForm
        mediaOptions={mediaOptions}
        instagramConnected={accounts.some((a) => a.platform === "INSTAGRAM")}
        tiktokConnected={accounts.some((a) => a.platform === "TIKTOK")}
        youtubeConnected={accounts.some((a) => a.platform === "YOUTUBE")}
        timezone={timezone}
        initialPost={initialPost}
        initialScheduleLocal={defaultScheduleLocal(timezone, dateParam)}
      />

      {drafts.length > 0 && (
        <div className="space-y-2.5">
          <h2 className="text-[13.5px] font-semibold">Brouillons récents</h2>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {drafts.map((draft) => (
              <Link key={draft.id} href={`/composer/${draft.id}`}>
                <Card className="transition-colors hover:bg-muted/50">
                  <CardContent className="py-0">
                    <p className="truncate text-[13.5px]">{draft.caption || "(sans légende)"}</p>
                    <p className="mt-0.5 text-[11.5px] text-muted-foreground">
                      Modifié le {formatInTimeZone(draft.updatedAt, timezone, "dd/MM/yyyy")}
                    </p>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
