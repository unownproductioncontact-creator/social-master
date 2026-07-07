import { notFound } from "next/navigation";
import { verifySession, getCurrentUser } from "@/lib/dal";
import { db } from "@/lib/db";
import { getPublicMediaUrl } from "@/lib/storage";
import { PostComposerForm } from "@/components/composer/post-composer-form";
import { SchedulePanel } from "@/components/composer/schedule-panel";
import { deletePost } from "@/lib/actions/posts";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

const POST_STATUS_LABELS: Record<string, string> = {
  DRAFT: "Brouillon",
  SCHEDULED: "Programmé",
  PARTIALLY_PUBLISHED: "Partiellement publié",
  PUBLISHED: "Publié",
  FAILED: "Échoué",
};

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

  const mediaOptions = mediaAssets.map((m) => ({
    id: m.id,
    url: getPublicMediaUrl(m.storageKey),
    mimeType: m.mimeType,
    isVideo: m.mimeType.startsWith("video/"),
  }));

  const isDraft = post.status === "DRAFT";

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {isDraft ? "Modifier le brouillon" : "Détail du post"}
          </h1>
          <Badge variant={post.status === "FAILED" ? "destructive" : "secondary"} className="mt-1">
            {POST_STATUS_LABELS[post.status] ?? post.status}
          </Badge>
        </div>
        {isDraft && (
          <form
            action={async () => {
              "use server";
              await deletePost(post.id);
            }}
          >
            <Button type="submit" variant="ghost" size="sm">
              Supprimer
            </Button>
          </form>
        )}
      </div>

      {isDraft ? (
        <PostComposerForm
          mediaOptions={mediaOptions}
          instagramConnected={accounts.some((a) => a.platform === "INSTAGRAM")}
          tiktokConnected={accounts.some((a) => a.platform === "TIKTOK")}
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
          }}
        />
      ) : (
        <div className="max-w-xl space-y-2 whitespace-pre-wrap rounded-md border p-4 text-sm">
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
          }))}
          canSchedule={Boolean(post.postMedia.length > 0 && post.postTargets.length > 0)}
        />
      </div>
    </div>
  );
}
