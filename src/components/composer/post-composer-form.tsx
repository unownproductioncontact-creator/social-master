"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { FileVideo } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { savePostDraft } from "@/lib/actions/posts";
import { computeInstagramContentType, computeTikTokContentType } from "@/lib/content-type";

type MediaOption = {
  id: string;
  url: string;
  mimeType: string;
  isVideo: boolean;
};

const IG_CONTENT_TYPE_LABELS: Record<string, string> = {
  REEL: "Reel",
  IMAGE: "Image",
  STORY: "Story",
  CAROUSEL: "Carrousel",
};

export function PostComposerForm({
  mediaOptions,
  instagramConnected,
  tiktokConnected,
  initialPost,
}: {
  mediaOptions: MediaOption[];
  instagramConnected: boolean;
  tiktokConnected: boolean;
  initialPost?: {
    id: string;
    caption: string;
    hashtags: string[];
    mediaAssetIds: string[];
    targetInstagram: boolean;
    targetInstagramStory: boolean;
    targetTiktok: boolean;
  };
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [caption, setCaption] = useState(initialPost?.caption ?? "");
  const [hashtagsText, setHashtagsText] = useState((initialPost?.hashtags ?? []).join(" "));
  const [mediaAssetIds, setMediaAssetIds] = useState<string[]>(
    initialPost?.mediaAssetIds.length ? initialPost.mediaAssetIds : mediaOptions[0] ? [mediaOptions[0].id] : []
  );
  const [targetInstagram, setTargetInstagram] = useState(initialPost?.targetInstagram ?? instagramConnected);
  const [targetInstagramStory, setTargetInstagramStory] = useState(initialPost?.targetInstagramStory ?? false);
  const [targetTiktok, setTargetTiktok] = useState(initialPost?.targetTiktok ?? false);

  const selectedMedia = useMemo(
    () => mediaAssetIds.map((id) => mediaOptions.find((m) => m.id === id)).filter((m): m is MediaOption => Boolean(m)),
    [mediaOptions, mediaAssetIds]
  );
  const mediaMeta = selectedMedia.map((m) => ({ isVideo: m.isVideo }));

  const igContentType =
    selectedMedia.length > 0
      ? computeInstagramContentType(selectedMedia.length, mediaMeta[0].isVideo, targetInstagramStory)
      : null;
  const tiktokContentType = mediaMeta.length > 0 ? computeTikTokContentType(mediaMeta) : null;

  function toggleMedia(id: string) {
    setMediaAssetIds((prev) => (prev.includes(id) ? prev.filter((m) => m !== id) : [...prev, id]));
  }

  function handleSave() {
    const hashtags = hashtagsText
      .split(/[\s,]+/)
      .map((h) => h.trim().replace(/^#/, ""))
      .filter(Boolean);

    startTransition(async () => {
      const result = await savePostDraft({
        postId: initialPost?.id,
        caption,
        hashtags,
        mediaAssetIds,
        targetInstagram,
        targetInstagramStory,
        targetTiktok,
      });
      if (result.error) {
        toast.error(result.error);
        return;
      }
      toast.success("Brouillon enregistré.");
      router.push(`/composer/${result.postId}`);
      router.refresh();
    });
  }

  const fullCaption = [caption, hashtagsText.trim() ? hashtagsText.trim().split(/\s+/).map((h) => (h.startsWith("#") ? h : `#${h}`)).join(" ") : ""]
    .filter(Boolean)
    .join("\n\n");

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="space-y-6">
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label>Média {selectedMedia.length > 1 && `(${selectedMedia.length} sélectionnés, carrousel)`}</Label>
          </div>
          {mediaOptions.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Aucun média disponible. Importez-en un dans la Médiathèque.
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
              {mediaOptions.map((media) => {
                const position = mediaAssetIds.indexOf(media.id);
                const isSelected = position !== -1;
                return (
                  <button
                    key={media.id}
                    type="button"
                    onClick={() => toggleMedia(media.id)}
                    className={`relative flex aspect-square items-center justify-center overflow-hidden rounded-md border-2 bg-muted ${
                      isSelected ? "border-foreground" : "border-transparent"
                    }`}
                  >
                    {media.isVideo ? (
                      <FileVideo className="size-6 text-muted-foreground" />
                    ) : (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={media.url} alt="" className="size-full object-cover" />
                    )}
                    {isSelected && (
                      <span className="absolute right-1 top-1 flex size-4 items-center justify-center rounded-full bg-foreground text-[10px] text-background">
                        {position + 1}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="caption">Caption</Label>
            <span className="text-xs text-muted-foreground">{caption.length}/2200</span>
          </div>
          <Textarea
            id="caption"
            value={caption}
            onChange={(e) => setCaption(e.target.value.slice(0, 2200))}
            rows={6}
            placeholder="Écrivez votre légende…"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="hashtags">Hashtags</Label>
          <Input
            id="hashtags"
            value={hashtagsText}
            onChange={(e) => setHashtagsText(e.target.value)}
            placeholder="pokemon tcg boosters"
          />
        </div>

        <div className="space-y-3">
          <Label>Plateformes</Label>
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Checkbox
                id="target-instagram"
                checked={targetInstagram}
                disabled={!instagramConnected}
                onCheckedChange={(checked) => setTargetInstagram(checked === true)}
              />
              <Label htmlFor="target-instagram" className="font-normal">
                Instagram {!instagramConnected && <span className="text-muted-foreground">(non connecté)</span>}
                {instagramConnected && igContentType && (
                  <Badge variant="outline" className="ml-2 text-xs">
                    {IG_CONTENT_TYPE_LABELS[igContentType]}
                  </Badge>
                )}
              </Label>
            </div>
            {targetInstagram && selectedMedia.length === 1 && (
              <div className="ml-6 flex items-center gap-2">
                <Checkbox
                  id="target-instagram-story"
                  checked={targetInstagramStory}
                  onCheckedChange={(checked) => setTargetInstagramStory(checked === true)}
                />
                <Label htmlFor="target-instagram-story" className="font-normal text-muted-foreground">
                  Publier en Story plutôt qu'en {mediaMeta[0]?.isVideo ? "Reel" : "post"}
                </Label>
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Checkbox
              id="target-tiktok"
              checked={targetTiktok}
              disabled={!tiktokConnected || tiktokContentType === null}
              onCheckedChange={(checked) => setTargetTiktok(checked === true)}
            />
            <Label htmlFor="target-tiktok" className="font-normal">
              TikTok{" "}
              {!tiktokConnected && <span className="text-muted-foreground">(non connecté)</span>}
              {tiktokConnected && tiktokContentType === null && selectedMedia.length > 0 && (
                <span className="text-muted-foreground">(1 vidéo seule, ou uniquement des photos)</span>
              )}
              {tiktokConnected && tiktokContentType === "TIKTOK_VIDEO" && (
                <span className="text-muted-foreground">— publié en brouillon (à finaliser dans l'app TikTok)</span>
              )}
              {tiktokConnected && tiktokContentType === "TIKTOK_PHOTO" && (
                <span className="text-muted-foreground">— post photo, en brouillon</span>
              )}
            </Label>
          </div>
        </div>

        <Button onClick={handleSave} disabled={isPending || mediaAssetIds.length === 0} className="w-full sm:w-auto">
          {isPending ? "Enregistrement…" : "Enregistrer le brouillon"}
        </Button>
      </div>

      <div>
        <Tabs defaultValue="instagram">
          <TabsList>
            <TabsTrigger value="instagram">Instagram</TabsTrigger>
            <TabsTrigger value="tiktok">TikTok</TabsTrigger>
          </TabsList>
          <TabsContent value="instagram">
            <PreviewMock media={selectedMedia[0] ?? null} extraCount={selectedMedia.length - 1} caption={fullCaption} />
          </TabsContent>
          <TabsContent value="tiktok">
            <PreviewMock media={selectedMedia[0] ?? null} extraCount={selectedMedia.length - 1} caption={fullCaption} />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

function PreviewMock({ media, extraCount, caption }: { media: MediaOption | null; extraCount: number; caption: string }) {
  return (
    <Card className="mx-auto max-w-xs overflow-hidden py-0">
      <div className="relative flex aspect-9/16 items-center justify-center bg-muted">
        {media ? (
          media.isVideo ? (
            <FileVideo className="size-10 text-muted-foreground" />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={media.url} alt="" className="size-full object-cover" />
          )
        ) : (
          <p className="p-4 text-center text-xs text-muted-foreground">Sélectionnez un média</p>
        )}
        {extraCount > 0 && (
          <Badge className="absolute right-2 top-2" variant="secondary">
            +{extraCount}
          </Badge>
        )}
      </div>
      <CardContent className="py-3">
        <p className="whitespace-pre-wrap text-xs text-muted-foreground">{caption || "Votre légende apparaîtra ici."}</p>
      </CardContent>
    </Card>
  );
}
