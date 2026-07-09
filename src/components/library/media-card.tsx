import { FileVideo } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { StatusBadge } from "@/components/ui/status-badge";
import { ConfirmDeleteButton } from "@/components/ui/confirm-delete-button";
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
  thumbnailKey?: string | null;
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
    <Card className="gap-0 overflow-hidden py-0">
      <div className="flex aspect-square items-center justify-center overflow-hidden bg-[linear-gradient(145deg,#2b2d3a,#4a4d63)] dark:bg-[linear-gradient(145deg,#1c1d26,#33354a)]">
        {isVideo ? (
          asset.thumbnailKey ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={getPublicMediaUrl(asset.thumbnailKey)}
              alt=""
              className="size-full object-cover"
            />
          ) : (
            <FileVideo className="size-8 text-white/85" />
          )
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={getPublicMediaUrl(asset.storageKey)}
            alt=""
            className="size-full object-cover"
          />
        )}
      </div>
      <CardContent className="space-y-2 py-2.5">
        <div className="flex items-center justify-between text-[11px] text-muted-foreground">
          <span>{formatSize(asset.sizeBytes)}</span>
          {asset.durationSec != null && <span className="tabular-nums">{Math.round(asset.durationSec)}s</span>}
        </div>
        <StatusBadge tone={hasErrors ? "err" : "ok"}>
          {hasErrors ? "Incompatible" : "Compatible"}
        </StatusBadge>
        <ConfirmDeleteButton
          onConfirm={deleteMediaAsset.bind(null, asset.id)}
          title="Supprimer ce média ?"
          description="Le fichier sera définitivement supprimé de votre stockage. Un média encore utilisé par un post ne peut pas être supprimé."
          successMessage="Média supprimé."
          triggerFullWidth
        />
      </CardContent>
    </Card>
  );
}
