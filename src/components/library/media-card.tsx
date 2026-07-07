import { FileVideo } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { deleteMediaAsset } from "@/lib/actions/media";
import { getPublicMediaUrl } from "@/lib/storage";
import {
  checkInstagramReelCompatibility,
  checkInstagramImageCompatibility,
  checkTikTokVideoCompatibility,
} from "@/lib/media-validation";

type MediaAssetSummary = {
  id: string;
  storageKey: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  durationSec: number | null;
  status: string;
};

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
}

export function MediaCard({ asset }: { asset: MediaAssetSummary }) {
  const isVideo = asset.mimeType.startsWith("video/");
  const meta = {
    mimeType: asset.mimeType,
    sizeBytes: asset.sizeBytes,
    durationSec: asset.durationSec,
    width: asset.width,
    height: asset.height,
  };

  const issues = isVideo
    ? [...checkInstagramReelCompatibility(meta), ...checkTikTokVideoCompatibility(meta)]
    : checkInstagramImageCompatibility(meta);
  const hasErrors = issues.some((i) => i.level === "error");

  return (
    <Card className="overflow-hidden py-0">
      <div className="flex aspect-square items-center justify-center bg-muted">
        {isVideo ? (
          <FileVideo className="size-10 text-muted-foreground" />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={getPublicMediaUrl(asset.storageKey)}
            alt=""
            className="size-full object-cover"
          />
        )}
      </div>
      <CardContent className="space-y-2 pb-4">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{formatSize(asset.sizeBytes)}</span>
          {asset.durationSec != null && <span>{Math.round(asset.durationSec)}s</span>}
        </div>
        <Badge variant={hasErrors ? "destructive" : "secondary"} className="text-xs">
          {hasErrors ? "Incompatible" : "Compatible"}
        </Badge>
        <form
          action={async () => {
            "use server";
            await deleteMediaAsset(asset.id);
          }}
        >
          <Button type="submit" variant="ghost" size="sm" className="w-full">
            Supprimer
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
