import Link from "next/link";
import { Layers } from "lucide-react";
import { verifySession } from "@/lib/dal";
import { db } from "@/lib/db";
import { getPublicMediaUrl } from "@/lib/storage";
import { PostComposerForm } from "@/components/composer/post-composer-form";
import { Card, CardContent } from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";
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
      <PageHeader
        title="Créer un post"
        description="Média, caption, hashtags et prévisualisation par plateforme."
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
