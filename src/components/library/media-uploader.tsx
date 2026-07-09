"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Progress, ProgressTrack, ProgressIndicator } from "@/components/ui/progress";
import { UploadCloud, X, RotateCcw, Loader2, CircleCheck, CircleAlert } from "lucide-react";
import { isAcceptedUploadType, MAX_UPLOAD_SIZE_BYTES } from "@/lib/media-validation";
import { UploadQueue, type UploadItem } from "@/lib/upload-queue";

type ImageMeta = { width: number; height: number; durationSec?: undefined };
type VideoMeta = { width: number; height: number; durationSec: number };

function readImageMeta(file: File): Promise<ImageMeta> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Impossible de lire l'image."));
    };
    img.src = url;
  });
}

function readVideoMeta(file: File): Promise<VideoMeta> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "metadata";
    video.onloadedmetadata = () => {
      URL.revokeObjectURL(url);
      resolve({ width: video.videoWidth, height: video.videoHeight, durationSec: video.duration });
    };
    video.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Impossible de lire la vidéo."));
    };
    video.src = url;
  });
}

const THUMBNAIL_MAX_WIDTH = 640;
const THUMBNAIL_SEEK_SEC = 0.5;

/**
 * Capture une frame de la vidéo (~0.5 s) via <video>+<canvas> et la renvoie en blob JPEG,
 * redimensionnée à THUMBNAIL_MAX_WIDTH de large max. Best-effort : toute erreur ici ne doit
 * jamais faire échouer l'upload principal, voir uploadThumbnailBestEffort() plus bas.
 */
function captureVideoThumbnail(file: File): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "auto";
    video.muted = true;
    video.playsInline = true;

    const cleanup = () => URL.revokeObjectURL(url);

    video.onloadedmetadata = () => {
      const seekTo = Math.min(THUMBNAIL_SEEK_SEC, Math.max(0, video.duration - 0.05 || 0));
      video.currentTime = seekTo;
    };
    video.onseeked = () => {
      try {
        const scale = Math.min(1, THUMBNAIL_MAX_WIDTH / video.videoWidth);
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(video.videoWidth * scale);
        canvas.height = Math.round(video.videoHeight * scale);
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Contexte canvas indisponible.");
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(
          (blob) => {
            cleanup();
            if (blob) resolve(blob);
            else reject(new Error("Échec de génération de la miniature."));
          },
          "image/jpeg",
          0.85
        );
      } catch (err) {
        cleanup();
        reject(err instanceof Error ? err : new Error("Échec de capture de la miniature."));
      }
    };
    video.onerror = () => {
      cleanup();
      reject(new Error("Impossible de lire la vidéo pour la miniature."));
    };
    video.src = url;
  });
}

/** Envoi best-effort de la miniature : ne lève jamais — un échec ici est silencieux (bonus, pas bloquant). */
async function uploadThumbnailBestEffort(mediaAssetId: string, file: File): Promise<void> {
  try {
    const blob = await captureVideoThumbnail(file);
    await fetch(`/api/media/${mediaAssetId}/thumbnail`, {
      method: "POST",
      headers: { "Content-Type": "image/jpeg" },
      body: blob,
    });
  } catch (err) {
    console.warn("[miniature] génération/envoi échoué (non bloquant)", err);
  }
}

/** PUT vers l'URL présignée via XMLHttpRequest, pour disposer de upload.onprogress. */
function putWithProgress(
  uploadUrl: string,
  file: File,
  onProgress: (percent: number) => void,
  signal: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", uploadUrl);
    xhr.setRequestHeader("Content-Type", file.type);

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error("Échec de l'envoi du fichier."));
    };
    xhr.onerror = () => reject(new Error("Échec de l'envoi du fichier."));
    xhr.onabort = () => reject(new Error("Envoi annulé."));

    const onAbort = () => xhr.abort();
    signal.addEventListener("abort", onAbort);
    // xhr.onloadend (pas xhr.upload.onloadend) : se déclenche systématiquement en dernier quel que
    // soit le chemin emprunté (load/error/abort/timeout), donc le listener est toujours retiré.
    xhr.onloadend = () => signal.removeEventListener("abort", onAbort);

    xhr.send(file);
  });
}

/**
 * Exécuteur injecté dans UploadQueue : réalise le flux complet presign → PUT (progression réelle
 * via XHR) → complete, inchangé côté API (voir CLAUDE.md). Le PUT est la seule étape annulable
 * (abort du XHR) ; presign/complete sont de petits appels JSON rapides, pas la peine de les rendre
 * annulables individuellement. En cas de succès et de fichier vidéo, tente une miniature en
 * best-effort — un échec de cette étape ne fait jamais échouer l'item.
 */
async function uploadExecutor(
  file: File,
  onProgress: (percent: number) => void,
  signal: AbortSignal
): Promise<{ mediaAssetId: string }> {
  const isVideo = file.type.startsWith("video/");
  const meta = isVideo ? await readVideoMeta(file) : await readImageMeta(file);

  const presignRes = await fetch("/api/media/presign", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fileName: file.name,
      mimeType: file.type,
      sizeBytes: file.size,
      width: meta.width,
      height: meta.height,
      durationSec: meta.durationSec,
    }),
    signal,
  });
  if (!presignRes.ok) {
    const body = await presignRes.json().catch(() => ({}));
    throw new Error(body.error || "Échec de préparation de l'upload.");
  }
  const { mediaAssetId, uploadUrl } = await presignRes.json();

  await putWithProgress(uploadUrl, file, onProgress, signal);

  const completeRes = await fetch(`/api/media/${mediaAssetId}/complete`, { method: "POST", signal });
  if (!completeRes.ok) {
    throw new Error("Échec de la finalisation de l'upload.");
  }

  if (isVideo) {
    // Ne jamais attendre/bloquer sur la miniature : l'upload est déjà READY à ce stade.
    void uploadThumbnailBestEffort(mediaAssetId, file);
  }

  return { mediaAssetId };
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
}

function ItemStatusIcon({ state }: { state: UploadItem<File, { mediaAssetId: string }>["state"] }) {
  switch (state) {
    case "done":
      return <CircleCheck className="size-4 text-primary" />;
    case "error":
      return <CircleAlert className="size-4 text-destructive" />;
    case "uploading":
      return <Loader2 className="size-4 animate-spin text-muted-foreground" />;
    default:
      return null;
  }
}

function UploadRow({
  item,
  onRetry,
  onCancel,
}: {
  item: UploadItem<File, { mediaAssetId: string }>;
  onRetry: (id: string) => void;
  onCancel: (id: string) => void;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border px-3 py-2">
      <ItemStatusIcon state={item.state} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <p className="truncate text-sm font-medium">{item.file.name}</p>
          <span className="shrink-0 text-xs text-muted-foreground">{formatSize(item.file.size)}</span>
        </div>
        {item.state === "uploading" || item.state === "pending" ? (
          <Progress value={item.state === "pending" ? 0 : item.progress} className="mt-1.5 gap-0">
            <ProgressTrack className="h-1.5">
              <ProgressIndicator />
            </ProgressTrack>
          </Progress>
        ) : item.state === "error" ? (
          <p className="mt-0.5 truncate text-xs text-destructive">{item.error ?? "Échec de l'envoi."}</p>
        ) : item.state === "cancelled" ? (
          <p className="mt-0.5 text-xs text-muted-foreground">Annulé.</p>
        ) : (
          <p className="mt-0.5 text-xs text-muted-foreground">Importé.</p>
        )}
      </div>
      {(item.state === "uploading" || item.state === "pending") && (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={`Annuler l'envoi de ${item.file.name}`}
          onClick={() => onCancel(item.id)}
        >
          <X className="size-3.5" />
        </Button>
      )}
      {(item.state === "error" || item.state === "cancelled") && (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={`Réessayer l'envoi de ${item.file.name}`}
          onClick={() => onRetry(item.id)}
        >
          <RotateCcw className="size-3.5" />
        </Button>
      )}
    </div>
  );
}

/** Média fraîchement importé, remonté via la prop `onUploaded` (voir MediaUploader). */
export type UploadedMedia = {
  mediaAssetId: string;
  fileName: string;
  mimeType: string;
  isVideo: boolean;
};

export function MediaUploader({ onUploaded }: { onUploaded?: (media: UploadedMedia) => void } = {}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const router = useRouter();

  const queueRef = useRef<UploadQueue<File, { mediaAssetId: string }> | null>(null);
  if (!queueRef.current) {
    queueRef.current = new UploadQueue<File, { mediaAssetId: string }>(uploadExecutor);
  }
  const [items, setItems] = useState<UploadItem<File, { mediaAssetId: string }>[]>([]);
  const previousDoneCount = useRef(0);
  // Les ids déjà notifiés via `onUploaded` — on ne notifie chaque média qu'une seule fois.
  const notifiedIds = useRef<Set<string>>(new Set());
  // On garde la dernière référence du callback sans le mettre en dépendance de l'effet (le parent
  // peut le recréer à chaque rendu) : ça évite de re-souscrire la queue à chaque rendu parent.
  const onUploadedRef = useRef(onUploaded);
  onUploadedRef.current = onUploaded;

  useEffect(() => {
    const queue = queueRef.current!;
    const unsubscribe = queue.subscribe((next) => {
      setItems(next);
      const doneCount = next.filter((i) => i.state === "done").length;
      if (doneCount > previousDoneCount.current) {
        router.refresh();
      }
      previousDoneCount.current = doneCount;

      // Notifie le parent pour chaque item terminé pas encore signalé (mode masse). Best-effort :
      // sans `onUploaded`, la Médiathèque fonctionne exactement comme avant (rétrocompatible).
      const notify = onUploadedRef.current;
      if (notify) {
        for (const item of next) {
          if (item.state === "done" && item.result && !notifiedIds.current.has(item.id)) {
            notifiedIds.current.add(item.id);
            notify({
              mediaAssetId: item.result.mediaAssetId,
              fileName: item.file.name,
              mimeType: item.file.type,
              isVideo: item.file.type.startsWith("video/"),
            });
          }
        }
      }
    });
    return unsubscribe;
  }, [router]);

  function handleFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList);

    for (const file of files) {
      if (!isAcceptedUploadType(file.type)) {
        toast.error(`${file.name} : type de fichier non supporté.`);
        continue;
      }
      if (file.size > MAX_UPLOAD_SIZE_BYTES) {
        toast.error(`${file.name} : fichier trop volumineux (max 4 Go).`);
        continue;
      }

      const id = `${file.name}-${file.size}-${file.lastModified}-${crypto.randomUUID()}`;
      queueRef.current!.add(id, file);
    }
  }

  const hasItems = items.length > 0;
  const isUploading = items.some((i) => i.state === "uploading" || i.state === "pending");

  return (
    <div className="space-y-3">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setIsDragging(false);
          handleFiles(e.dataTransfer.files);
        }}
        className={`flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-10 text-center transition-colors ${
          isDragging ? "border-foreground bg-muted/50" : "border-border"
        }`}
      >
        {isUploading ? (
          <Loader2 className="size-8 animate-spin text-muted-foreground" />
        ) : (
          <UploadCloud className="size-8 text-muted-foreground" />
        )}
        <div>
          <p className="text-sm font-medium">Glissez-déposez vos images ou vidéos</p>
          <p className="text-xs text-muted-foreground">JPEG, PNG, WebP, MP4, MOV, WebM — 4 Go max</p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => inputRef.current?.click()}>
          Parcourir
        </Button>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm"
          className="hidden"
          onChange={(e) => {
            handleFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {hasItems && (
        <div className="space-y-2">
          {items.map((item) => (
            <UploadRow
              key={item.id}
              item={item}
              onRetry={(id) => queueRef.current!.retry(id)}
              onCancel={(id) => queueRef.current!.cancel(id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
