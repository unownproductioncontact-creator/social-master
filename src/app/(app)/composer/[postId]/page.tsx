import Link from "next/link";
import { notFound } from "next/navigation";
import { Info } from "lucide-react";
import { verifySession, getCurrentUser } from "@/lib/dal";
import { db } from "@/lib/db";
import { getPublicMediaUrl } from "@/lib/storage";
import { PostComposerForm } from "@/components/composer/post-composer-form";
import { SchedulePanel } from "@/components/composer/schedule-panel";
import { deletePost } from "@/lib/actions/posts";
import { ConfirmDeleteButton } from "@/components/ui/confirm-delete-button";
import { StatusBadge, postStatusTone, postStatusLabel } from "@/components/ui/status-badge";
import { PageHeader } from "@/components/layout/page-header";
import { buttonVariants } from "@/components/ui/button";
import { CopyCaptionButton } from "@/components/history/copy-caption-button";
import { AutoRefresh } from "@/components/util/auto-refresh";

/**
 * Reconstitue un nom lisible depuis la clé de stockage `media/{userId}/{uuid}-{nom_de_fichier}`
 * (voir buildStorageKey). Recopié localement depuis composer/bulk/page.tsx (fichier non modifiable).
 */
function displayNameFromStorageKey(storageKey: string): string {
  const base = storageKey.split("/").pop() ?? storageKey;
  const match = base.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-(.+)$/i);
  return match ? match[1] : base;
}

export default async function EditPostPage(props: PageProps<"/composer/[postId]">) {
  const session = await verifySession();
  const { postId } = await props.params;

  const [post, mediaAssets, accounts, user] = await Promise.all([
    db.post.findUnique({
      where: { id: postId },
      include: { postMedia: true, postTargets: true },
    }),
    db.mediaAsset.findMany({ where: { userId: session.userId, status: "READY" }, orderBy: { createdAt: "desc" } }),
    db.socialAccount.findMany({ where: { userId: session.userId } }),
    getCurrentUser(),
  ]);

  if (!post || post.userId !== session.userId) {
    notFound();
  }

  // P1-7b : une cible TikTok déjà déposée en brouillon inbox reste « à finaliser » côté user —
  // la légende doit être copiable ICI (jusqu'à présent uniquement depuis l'Historique), au moment
  // même où le lien de la notification Telegram ramène sur cette page (voir worker/publish-job.ts).
  const tiktokInboxTarget = post.postTargets.find(
    (t) => t.platform === "TIKTOK" && t.status === "SENT_TO_INBOX"
  );

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

  const isDraft = post.status === "DRAFT";

  // Plateformes déjà servies (P1-2) : une cible PUBLISHED/SENT_TO_INBOX ne sera jamais republiée par le
  // moteur (voir savePostDraft) — le formulaire l'indique en verrouillant la case correspondante.
  const servedPlatforms = Array.from(
    new Set(
      post.postTargets
        .filter((t) => t.status === "PUBLISHED" || t.status === "SENT_TO_INBOX")
        .map((t) => t.platform)
    )
  );

  return (
    <div className="space-y-6">
      <AutoRefresh />
      <PageHeader
        title={isDraft ? "Modifier le brouillon" : "Détail du post"}
        description={
          <StatusBadge tone={postStatusTone(post.status)} className="mt-1">
            {postStatusLabel(post.status)}
          </StatusBadge>
        }
        actions={
          <>
            {/* P2-5a : chemin propre pour « re-poster » un contenu, quel que soit son statut — pré-remplit
                un NOUVEAU brouillon via /composer?duplicate=, ne touche jamais ce post-ci. */}
            <Link href={`/composer?duplicate=${post.id}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
              Dupliquer
            </Link>
            <ConfirmDeleteButton
              onConfirm={deletePost.bind(null, post.id)}
              title="Supprimer ce post ?"
              description={
                isDraft
                  ? "Ce brouillon et son contenu seront définitivement supprimés. Les médias associés resteront dans votre médiathèque."
                  : "Le post sera retiré de votre planificateur et sa programmation annulée. Le contenu déjà envoyé sur TikTok ou publié sur Instagram n’est pas affecté. Les médias resteront dans votre médiathèque."
              }
            />
          </>
        }
      />

      {tiktokInboxTarget && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 px-4 py-3">
          <div className="flex items-start gap-2 text-[12.5px] text-muted-foreground">
            <Info className="mt-0.5 size-4 shrink-0" />
            <p>La vidéo vous attend dans les notifications de l’app TikTok.</p>
          </div>
          <CopyCaptionButton
            caption={post.caption}
            hashtags={post.hashtags}
            captionOverride={tiktokInboxTarget.captionOverride}
          />
        </div>
      )}

      {isDraft ? (
        <PostComposerForm
          mediaOptions={mediaOptions}
          instagramConnected={accounts.some((a) => a.platform === "INSTAGRAM")}
          tiktokConnected={accounts.some((a) => a.platform === "TIKTOK")}
          youtubeConnected={accounts.some((a) => a.platform === "YOUTUBE")}
          timezone={user?.timezone ?? "Europe/Paris"}
          servedPlatforms={servedPlatforms}
          initialPost={{
            id: post.id,
            caption: post.caption,
            hashtags: post.hashtags,
            mediaAssetIds: post.postMedia
              .slice()
              .sort((a, b) => a.position - b.position)
              .map((pm) => pm.mediaAssetId),
            targetInstagram: post.postTargets.some((t) => t.platform === "INSTAGRAM"),
            targetInstagramStory: post.postTargets.some((t) => t.platform === "INSTAGRAM" && t.contentType === "STORY"),
            targetTiktok: post.postTargets.some((t) => t.platform === "TIKTOK"),
            targetYoutube: post.postTargets.some((t) => t.platform === "YOUTUBE"),
            youtubeTitle:
              (post.postTargets.find((t) => t.platform === "YOUTUBE")?.platformOptions as { title?: string } | null)
                ?.title ?? undefined,
            instagramCoverTimeMs:
              (post.postTargets.find((t) => t.platform === "INSTAGRAM")?.platformOptions as { coverTimeMs?: number } | null)
                ?.coverTimeMs ?? null,
          }}
        />
      ) : (
        <div className="max-w-xl space-y-2 whitespace-pre-wrap rounded-lg border border-border bg-card p-4 text-[13.5px]">
          {post.caption}
          {post.hashtags.length > 0 && (
            <p className="text-muted-foreground">{post.hashtags.map((h) => `#${h}`).join(" ")}</p>
          )}
        </div>
      )}

      <div className="max-w-xl">
        <SchedulePanel
          postId={post.id}
          postStatus={post.status}
          scheduledAt={post.scheduledAt}
          timezone={user?.timezone ?? "Europe/Paris"}
          targets={post.postTargets.map((t) => ({
            id: t.id,
            platform: t.platform,
            status: t.status,
            errorMessage: t.errorMessage,
            platformPostUrl: t.platformPostUrl,
            scheduledAt: t.scheduledAt,
          }))}
          canSchedule={Boolean(post.postMedia.length > 0 && post.postTargets.length > 0)}
        />
      </div>
    </div>
  );
}
