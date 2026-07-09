import Link from "next/link";
import { verifySession } from "@/lib/dal";
import { db } from "@/lib/db";
import { getPublicMediaUrl } from "@/lib/storage";
import { PostComposerForm } from "@/components/composer/post-composer-form";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/layout/page-header";

export default async function ComposerPage() {
  const session = await verifySession();

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
    mimeType: m.mimeType,
    isVideo: m.mimeType.startsWith("video/"),
  }));

  return (
    <div className="space-y-8">
      <PageHeader title="Créer un post" description="Média, caption, hashtags et prévisualisation par plateforme." />

      <PostComposerForm
        mediaOptions={mediaOptions}
        instagramConnected={accounts.some((a) => a.platform === "INSTAGRAM")}
        tiktokConnected={accounts.some((a) => a.platform === "TIKTOK")}
      />

      {drafts.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-medium text-muted-foreground">Brouillons récents</h2>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {drafts.map((draft) => (
              <Link key={draft.id} href={`/composer/${draft.id}`}>
                <Card className="transition-colors hover:bg-muted/50">
                  <CardContent className="py-3">
                    <p className="truncate text-sm">{draft.caption || "(sans légende)"}</p>
                    <p className="text-xs text-muted-foreground">
                      Modifié le {draft.updatedAt.toLocaleDateString("fr-FR")}
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
