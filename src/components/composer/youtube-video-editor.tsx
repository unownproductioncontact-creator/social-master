"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { formatInTimeZone } from "date-fns-tz";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PlatformChip } from "@/components/ui/platform-chip";
import { loadYouTubeVideoAction, updateYouTubeVideoAction, type YouTubeVideoForm } from "@/lib/actions/youtube-video";
import { YOUTUBE_TITLE_MAX_LENGTH } from "@/lib/content-type";
import { YOUTUBE_PRIVACY_LABELS, type YouTubePrivacyStatus } from "@/lib/youtube-options";
import {
  normalizeTags,
  RECONNECT_FOR_EDIT_MESSAGE,
  tagsLength,
  utf8Bytes,
  YOUTUBE_DESCRIPTION_MAX_BYTES,
  YOUTUBE_TAGS_MAX_LENGTH,
} from "@/lib/youtube-video-edit";
import { cn } from "@/lib/utils";

const PRIVACY_OPTIONS = (["public", "unlisted", "private"] as const).map((value) => ({
  value,
  label: YOUTUBE_PRIVACY_LABELS[value].charAt(0).toUpperCase() + YOUTUBE_PRIVACY_LABELS[value].slice(1),
}));

function Counter({ value, max, unit }: { value: number; max: number; unit: string }) {
  return (
    <span className={cn("text-[11px] tabular-nums", value > max ? "text-destructive" : "text-muted-foreground")}>
      {value} / {max} {unit}
    </span>
  );
}

/**
 * Modifier sur YouTube la vidéo d'un post publié ou programmé chez YouTube (CLAUDE.md §39) : titre,
 * description, tags, visibilité. Chargée à la demande (pas au rendu : l'actualisation automatique de la
 * page consommerait du quota YouTube) ; n'envoie que les champs réellement modifiés.
 */
export function YouTubeVideoEditor({ postId, timezone }: { postId: string; timezone: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [video, setVideo] = useState<YouTubeVideoForm | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [tagsText, setTagsText] = useState("");
  const [privacy, setPrivacy] = useState<YouTubePrivacyStatus | "unknown">("unknown");

  function open() {
    setLoadError(null);
    startTransition(async () => {
      const result = await loadYouTubeVideoAction(postId);
      if (result.error || !result.video) {
        setLoadError(result.error ?? "Lecture de la vidéo impossible.");
        return;
      }
      setVideo(result.video);
      setTitle(result.video.title);
      setDescription(result.video.description);
      setTagsText(result.video.tags.join(", "));
      setPrivacy(result.video.privacy);
    });
  }

  if (!video) {
    return (
      <Card className="gap-0 py-0">
        <CardContent className="space-y-2 px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <PlatformChip platform="YOUTUBE" />
              <p className="text-[12.5px] text-muted-foreground">Titre, description, tags et visibilité de la vidéo en ligne.</p>
            </div>
            <Button variant="outline" size="sm" onClick={open} disabled={isPending}>
              {isPending ? "Lecture…" : "Modifier sur YouTube"}
            </Button>
          </div>
          {loadError && <p className="text-[12.5px] text-destructive">{loadError}</p>}
        </CardContent>
      </Card>
    );
  }

  const tags = normalizeTags(tagsText.split(","));
  const titleCount = [...title.trim()].length;
  const descriptionBytes = utf8Bytes(description.replace(/\r\n/g, "\n").trimEnd());
  const tagsCount = tagsLength(tags);
  const changed = {
    title: title.trim() !== video.title,
    description: description.replace(/\r\n/g, "\n").trimEnd() !== video.description,
    tags: tags.join("\u0000") !== video.tags.join("\u0000"),
    privacy: privacy !== "unknown" && privacy !== video.privacy,
  };
  const dirty = Object.values(changed).some(Boolean);
  const invalidMessage =
    titleCount === 0
      ? "Le titre ne peut pas être vide."
      : titleCount > YOUTUBE_TITLE_MAX_LENGTH
        ? "Titre trop long."
        : descriptionBytes > YOUTUBE_DESCRIPTION_MAX_BYTES
          ? "Description trop longue."
          : tagsCount > YOUTUBE_TAGS_MAX_LENGTH
            ? "Tags trop longs."
            : /[<>]/.test(title + description + tagsText)
              ? "YouTube refuse les caractères < et >."
              : null;
  const cannotEdit = video.editScope === "missing";
  const publishesNow = video.scheduledBySocialMaster && changed.privacy && privacy === "public";

  function save() {
    if (!video) return;
    startTransition(async () => {
      const result = await updateYouTubeVideoAction({
        postId,
        ...(changed.title ? { title } : {}),
        ...(changed.description ? { description } : {}),
        ...(changed.tags ? { tags } : {}),
        ...(changed.privacy && privacy !== "unknown" ? { privacy } : {}),
      });
      if (result.error) {
        toast.error(result.error);
        return;
      }
      toast.success(result.changed?.length ? "Vidéo modifiée sur YouTube." : "Rien n’a changé.", {
        description: result.notes?.join(" "),
      });
      setVideo(null);
      router.refresh();
    });
  }

  const privacyOptions = video.scheduledBySocialMaster
    ? [
        {
          value: "private",
          label: video.publishAt
            ? `Programmée : publique le ${formatInTimeZone(new Date(video.publishAt), timezone, "dd/MM 'à' HH:mm")}`
            : "Privée",
        },
        { value: "public", label: "Publier maintenant" },
      ]
    : PRIVACY_OPTIONS;

  return (
    <Card className="gap-0 py-0">
      <CardContent className="space-y-4 px-4 py-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <PlatformChip platform="YOUTUBE" />
          <a href={video.url} target="_blank" rel="noreferrer" className="text-[12.5px] text-muted-foreground underline">
            Voir sur YouTube
          </a>
        </div>

        {cannotEdit && (
          <div className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-[12.5px] text-amber-700 dark:text-amber-400">
            <p>{RECONNECT_FOR_EDIT_MESSAGE}</p>
            <Link href="/connections" className={buttonVariants({ size: "xs", variant: "outline" })}>
              Aller aux Connexions
            </Link>
          </div>
        )}

        <fieldset disabled={cannotEdit || isPending} className="space-y-4">
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="yt-edit-title" className="text-xs font-semibold">
                Titre
              </Label>
              <Counter value={titleCount} max={YOUTUBE_TITLE_MAX_LENGTH} unit="caractères" />
            </div>
            <Input id="yt-edit-title" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="yt-edit-description" className="text-xs font-semibold">
                Description
              </Label>
              <Counter value={descriptionBytes} max={YOUTUBE_DESCRIPTION_MAX_BYTES} unit="octets" />
            </div>
            <Textarea
              id="yt-edit-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={6}
            />
            <p className="text-[11.5px] text-muted-foreground">
              Modifie seulement YouTube : la légende du post (Instagram, TikTok) ne change pas.
            </p>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="yt-edit-tags" className="text-xs font-semibold">
                Tags
              </Label>
              <Counter value={tagsCount} max={YOUTUBE_TAGS_MAX_LENGTH} unit="caractères" />
            </div>
            <Input
              id="yt-edit-tags"
              value={tagsText}
              onChange={(e) => setTagsText(e.target.value)}
              placeholder="pokemon, carte pokemon, booster"
            />
            <p className="text-[11.5px] text-muted-foreground">Mots-clés séparés par des virgules.</p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="yt-edit-privacy" className="text-xs font-semibold">
              Visibilité
            </Label>
            <Select items={privacyOptions} value={privacy} onValueChange={(v) => setPrivacy(v as YouTubePrivacyStatus)}>
              <SelectTrigger id="yt-edit-privacy" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {privacyOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {publishesNow ? (
              <p className="text-[11.5px] text-amber-700 dark:text-amber-400">
                La vidéo sera publiée immédiatement, sans attendre l’heure prévue.
              </p>
            ) : video.scheduledBySocialMaster ? (
              <p className="text-[11.5px] text-muted-foreground">
                Pour changer l’heure de publication, utilisez « Modifier l’horaire » ci-dessous.
              </p>
            ) : null}
          </div>
        </fieldset>

        {invalidMessage && dirty && <p className="text-[12.5px] text-destructive">{invalidMessage}</p>}

        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setVideo(null)} disabled={isPending}>
            Fermer
          </Button>
          <Button size="sm" onClick={save} disabled={cannotEdit || !dirty || Boolean(invalidMessage) || isPending}>
            {isPending ? "Envoi à YouTube…" : "Enregistrer sur YouTube"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
