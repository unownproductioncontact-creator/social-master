"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { UploadCloud, Loader2 } from "lucide-react";
import { isAcceptedUploadType, MAX_UPLOAD_SIZE_BYTES } from "@/lib/media-validation";

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

async function uploadFile(file: File) {
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
  });
  if (!presignRes.ok) {
    const body = await presignRes.json().catch(() => ({}));
    throw new Error(body.error || "Échec de préparation de l'upload.");
  }
  const { mediaAssetId, uploadUrl } = await presignRes.json();

  const putRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": file.type },
    body: file,
  });
  if (!putRes.ok) {
    throw new Error("Échec de l'envoi du fichier.");
  }

  const completeRes = await fetch(`/api/media/${mediaAssetId}/complete`, { method: "POST" });
  if (!completeRes.ok) {
    throw new Error("Échec de la finalisation de l'upload.");
  }
}

export function MediaUploader() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, startUpload] = useTransition();
  const router = useRouter();

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

      startUpload(async () => {
        try {
          await uploadFile(file);
          toast.success(`${file.name} importé.`);
          router.refresh();
        } catch (err) {
          toast.error(err instanceof Error ? err.message : `Échec de l'import de ${file.name}.`);
        }
      });
    }
  }

  return (
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
        onChange={(e) => handleFiles(e.target.files)}
      />
    </div>
  );
}
