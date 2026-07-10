"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { FileVideo, Moon } from "lucide-react";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { Button, buttonVariants } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { savePostDraft, scheduleExistingPost } from "@/lib/actions/posts";
import { computeInstagramContentType, computeTikTokContentType } from "@/lib/content-type";
import { isInQuietWindow, suggestWakeTime, QUIET_WINDOW_LABEL } from "@/lib/schedule-window";
import { getLastUsed, rememberHashtags, rememberScheduleHour, truncatePreview } from "@/lib/last-used";

type ServedPlatform = "INSTAGRAM" | "TIKTOK";

type MediaOption = {
  id: string;
  url: string;
  mimeType: string;
  isVideo: boolean;
  /** Miniature réelle (thumbnailKey d'une vidéo) — null pour une image (on affiche l'image elle-même). */
  thumbnailUrl?: string | null;
  /** Nom de fichier lisible reconstitué depuis la clé de stockage. */
  name?: string;
};

const IG_CONTENT_TYPE_LABELS: Record<string, string> = {
  REEL: "Reel",
  IMAGE: "Image",
  STORY: "Story",
  CAROUSEL: "Carrousel",
};

const DATETIME_LOCAL_FORMAT = "yyyy-MM-dd'T'HH:mm";

/** Datetime-local (heure LOCALE du fuseau utilisateur) pour DEMAIN à `hour`:00. Pur calendaire (voir schedule-window). */
function tomorrowLocalAt(hour: number, timezone: string): string {
  const today = formatInTimeZone(new Date(), timezone, "yyyy-MM-dd");
  const [year, month, day] = today.split("-").map(Number);
  const dt = new Date(Date.UTC(year, month - 1, day));
  dt.setUTCDate(dt.getUTCDate() + 1);
  return `${dt.toISOString().slice(0, 10)}T${String(hour).padStart(2, "0")}:00`;
}

/** Datetime-local (heure LOCALE du fuseau utilisateur) pour maintenant + 1 h. */
function inOneHourLocal(timezone: string): string {
  return formatInTimeZone(new Date(Date.now() + 3_600_000), timezone, DATETIME_LOCAL_FORMAT);
}

export function PostComposerForm({
  mediaOptions,
  instagramConnected,
  tiktokConnected,
  timezone,
  initialPost,
  initialScheduleLocal,
  servedPlatforms,
}: {
  mediaOptions: MediaOption[];
  instagramConnected: boolean;
  tiktokConnected: boolean;
  /** Fuseau de l'utilisateur (UTC en base, saisie interprétée dans ce fuseau). */
  timezone: string;
  /**
   * Valeurs initiales. `id` présent = édition d'un post existant (met à jour + masque la
   * programmation intégrée, gérée par le SchedulePanel de la page). `id` absent = nouveau brouillon
   * éventuellement pré-rempli (duplication, ?media). Les cases plateformes non fournies retombent sur
   * les défauts intelligents (= plateforme connectée).
   */
  initialPost?: {
    id?: string;
    caption?: string;
    hashtags?: string[];
    mediaAssetIds?: string[];
    targetInstagram?: boolean;
    targetInstagramStory?: boolean;
    targetTiktok?: boolean;
    instagramCoverTimeMs?: number | null;
  };
  /** Valeur par défaut du champ de programmation (datetime-local, heure locale). Nouveau post seulement. */
  initialScheduleLocal?: string;
  /** Plateformes déjà servies (cible PUBLISHED/SENT_TO_INBOX) : case cochée-verrouillée, jamais republiée. */
  servedPlatforms?: ServedPlatform[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const isEditingExisting = Boolean(initialPost?.id);
  const servedInstagram = servedPlatforms?.includes("INSTAGRAM") ?? false;
  const servedTiktok = servedPlatforms?.includes("TIKTOK") ?? false;

  const [caption, setCaption] = useState(initialPost?.caption ?? "");
  const [hashtagsText, setHashtagsText] = useState((initialPost?.hashtags ?? []).join(" "));
  const [mediaAssetIds, setMediaAssetIds] = useState<string[]>(
    initialPost?.mediaAssetIds?.length ? initialPost.mediaAssetIds : mediaOptions[0] ? [mediaOptions[0].id] : []
  );
  // Défauts intelligents (P1-6a) : pour un NOUVEAU post, pré-cocher chaque plateforme connectée. En
  // édition/duplication, les valeurs explicites du post sont conservées (?? ne retombe que sur null/undefined).
  const [targetInstagram, setTargetInstagram] = useState(initialPost?.targetInstagram ?? instagramConnected);
  const [targetInstagramStory, setTargetInstagramStory] = useState(initialPost?.targetInstagramStory ?? false);
  const [targetTiktok, setTargetTiktok] = useState(initialPost?.targetTiktok ?? tiktokConnected);
  const [coverTimeMs, setCoverTimeMs] = useState<number | null>(initialPost?.instagramCoverTimeMs ?? null);
  const [dateTime, setDateTime] = useState(initialScheduleLocal ?? "");
  // Vrai dès que l'utilisateur modifie lui-même le champ de programmation (saisie ou raccourci) — sert
  // à protéger sa saisie contre le pré-remplissage mémoire ci-dessous (voir l'effet de montage).
  const dateTimeTouchedRef = useRef(false);

  /** Mémoire de saisie (P2-5b) : derniers hashtags mémorisés, lus seulement après montage (voir effet ci-dessous). */
  const [lastUsedHashtags, setLastUsedHashtags] = useState<string | null>(null);

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

  // Valeurs effectives des cases (P1-2) : une plateforme servie est forcée cochée ; TikTok ne peut pas
  // rester coché sur une combinaison de médias qu'il refuse (sinon la sauvegarde échouerait).
  const tiktokEligible = tiktokConnected && tiktokContentType !== null;
  const igChecked = servedInstagram || targetInstagram;
  const igDisabled = !instagramConnected || servedInstagram;
  const tiktokChecked = servedTiktok || (targetTiktok && tiktokEligible);
  const tiktokDisabled = !tiktokConnected || servedTiktok || tiktokContentType === null;

  // Avertissement fenêtre morte 23h–7h (P1-3) : l'heure saisie est interprétée dans le fuseau utilisateur.
  const quietWarning = useMemo(() => {
    if (!dateTime) return false;
    const instant = fromZonedTime(dateTime, timezone);
    if (Number.isNaN(instant.getTime())) return false;
    return isInQuietWindow(instant, timezone);
  }, [dateTime, timezone]);

  /** Change l'horaire ET marque le champ comme touché — passe par ici pour toute modif (saisie ou raccourci). */
  function updateDateTime(value: string) {
    dateTimeTouchedRef.current = true;
    setDateTime(value);
  }

  function shiftToWakeTime() {
    const instant = fromZonedTime(dateTime, timezone);
    if (Number.isNaN(instant.getTime())) return;
    updateDateTime(formatInTimeZone(suggestWakeTime(instant, timezone), timezone, DATETIME_LOCAL_FORMAT));
  }

  // Mémoire de saisie (P2-5b) : lue seulement APRÈS montage — localStorage n'existe pas côté serveur, le
  // lire pendant le rendu initial casserait l'hydratation (voir l'avertissement en tête de last-used.ts
  // et CLAUDE.md §12). Déps stables (primitives) pour une exécution effectivement unique par montage.
  useEffect(() => {
    const stored = getLastUsed();
    if (!stored) return;
    if (stored.hashtags) setLastUsedHashtags(stored.hashtags);
    // Horaire mémorisé : uniquement pour un NOUVEAU post (le bloc de programmation est masqué en
    // édition, cf. `!isEditingExisting` plus bas — `initialScheduleLocal` n'est d'ailleurs jamais fourni
    // dans ce cas), et seulement si l'utilisateur n'a pas déjà touché le champ entre le montage et
    // l'exécution de cet effet. Remplace UNIQUEMENT l'heure du défaut serveur (demain 18:00, ou
    // {?date}T18:00 — voir composer/page.tsx), en conservant la date déjà calculée côté serveur.
    if (!isEditingExisting && stored.scheduleHour && !dateTimeTouchedRef.current) {
      const datePart = (initialScheduleLocal ?? "").slice(0, 10);
      if (datePart) setDateTime(`${datePart}T${stored.scheduleHour}`);
    }
  }, [isEditingExisting, initialScheduleLocal]);

  function toggleMedia(id: string) {
    setMediaAssetIds((prev) => (prev.includes(id) ? prev.filter((m) => m !== id) : [...prev, id]));
  }

  /**
   * Enregistre le brouillon, puis — en mode « schedule » avec un horaire renseigné — programme le post
   * dans la foulée (P1-6b). Si la programmation échoue APRÈS un enregistrement réussi, le brouillon
   * existe déjà : on redirige vers sa page d'édition (le SchedulePanel y permet de reprendre).
   */
  function submit(mode: "schedule" | "draft") {
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
        targetInstagram: igChecked,
        targetInstagramStory,
        targetTiktok: tiktokChecked,
        instagramCoverTimeMs: igContentType === "REEL" ? coverTimeMs : null,
      });
      if (result.error) {
        toast.error(result.error);
        return;
      }
      const savedId = result.postId!;

      // Mémoire de saisie (P2-5b) : un enregistrement réussi retient les hashtags saisis, et l'heure de
      // programmation si un horaire était renseigné dans le champ — indépendamment du sort de la
      // programmation elle-même ci-dessous (rememberHashtags/rememberScheduleHour ignorent déjà les
      // valeurs vides/invalides, voir last-used.ts).
      rememberHashtags(hashtagsText);
      const hourPart = dateTime.trim() !== "" ? dateTime.split("T")[1] : undefined;
      if (hourPart) rememberScheduleHour(hourPart);

      const shouldSchedule = mode === "schedule" && dateTime.trim() !== "";
      if (!shouldSchedule) {
        toast.success("Brouillon enregistré.");
        router.push(`/composer/${savedId}`);
        router.refresh();
        return;
      }

      const scheduleResult = await scheduleExistingPost({ postId: savedId, scheduledAtLocal: dateTime, timezone });
      if (scheduleResult.error) {
        toast.error(`Brouillon enregistré, mais la programmation a échoué : ${scheduleResult.error} Reprenez la programmation ci-dessous.`);
        router.push(`/composer/${savedId}`);
        router.refresh();
        return;
      }
      toast.success("Post programmé.");
      router.push(`/composer/${savedId}`);
      router.refresh();
    });
  }

  const fullCaption = [caption, hashtagsText.trim() ? hashtagsText.trim().split(/\s+/).map((h) => (h.startsWith("#") ? h : `#${h}`)).join(" ") : ""]
    .filter(Boolean)
    .join("\n\n");

  const primaryLabel = isPending ? "Enregistrement…" : dateTime ? "Programmer" : "Enregistrer le brouillon";

  // Puce « Réutiliser les derniers hashtags » (P2-5b) : seulement si le champ était vide au montage
  // (jamais sur un post dupliqué/édité qui a déjà ses hashtags) ET s'il est ENCORE vide (se cache dès
  // que l'utilisateur tape ou clique la puce) ET qu'une mémoire existe.
  const hashtagsEmptyAtMount = !initialPost?.hashtags?.length;
  const showReuseHashtagsChip = hashtagsEmptyAtMount && hashtagsText.trim() === "" && Boolean(lastUsedHashtags);

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="space-y-5">
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label className="text-xs font-semibold">
              Média {selectedMedia.length > 1 && `(${selectedMedia.length} sélectionnés, carrousel)`}
            </Label>
          </div>
          {mediaOptions.length === 0 ? (
            <div className="space-y-2.5 rounded-lg border border-dashed border-border px-3 py-4">
              <p className="text-[13.5px] text-muted-foreground">
                Aucun média disponible. Importez une vidéo ou une image dans la Médiathèque.
              </p>
              <Link href="/library" className={buttonVariants({ variant: "outline", size: "sm" })}>
                Ouvrir la médiathèque
              </Link>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
              {mediaOptions.map((media) => {
                const position = mediaAssetIds.indexOf(media.id);
                const isSelected = position !== -1;
                return (
                  <div key={media.id} className="space-y-1">
                    <button
                      type="button"
                      onClick={() => toggleMedia(media.id)}
                      title={media.name}
                      className={`relative flex aspect-square w-full items-center justify-center overflow-hidden rounded-lg border-2 bg-muted ${
                        isSelected ? "border-foreground" : "border-transparent"
                      }`}
                    >
                      {media.thumbnailUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={media.thumbnailUrl} alt="" className="size-full object-cover" />
                      ) : media.isVideo ? (
                        <FileVideo className="size-6 text-muted-foreground" />
                      ) : (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={media.url} alt="" className="size-full object-cover" />
                      )}
                      {media.isVideo && media.thumbnailUrl && (
                        <span className="absolute bottom-1 left-1 flex size-4 items-center justify-center rounded bg-foreground/60 text-background">
                          <FileVideo className="size-2.5" />
                        </span>
                      )}
                      {isSelected && (
                        <span className="absolute right-1 top-1 flex size-4 items-center justify-center rounded-full bg-foreground text-[10px] text-background">
                          {position + 1}
                        </span>
                      )}
                    </button>
                    {media.name && (
                      <p className="truncate text-[11px] text-muted-foreground" title={media.name}>
                        {media.name}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="caption" className="text-xs font-semibold">
              Légende
            </Label>
            <span className="text-[11.5px] text-muted-foreground">{caption.length}/2200</span>
          </div>
          <Textarea
            id="caption"
            value={caption}
            onChange={(e) => setCaption(e.target.value.slice(0, 2200))}
            rows={6}
            placeholder="Écrivez votre légende…"
          />
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="hashtags" className="text-xs font-semibold">
              Hashtags
            </Label>
            {showReuseHashtagsChip && (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                title={truncatePreview(lastUsedHashtags!)}
                onClick={() => setHashtagsText(lastUsedHashtags!)}
              >
                Réutiliser les derniers hashtags
              </Button>
            )}
          </div>
          <Input
            id="hashtags"
            value={hashtagsText}
            onChange={(e) => setHashtagsText(e.target.value)}
            placeholder="pokemon tcg boosters"
          />
        </div>

        <div className="space-y-2.5">
          <Label className="text-xs font-semibold">Plateformes</Label>
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Checkbox
                id="target-instagram"
                checked={igChecked}
                disabled={igDisabled}
                onCheckedChange={(checked) => setTargetInstagram(checked === true)}
              />
              <Label htmlFor="target-instagram" className="text-[13.5px] font-normal">
                Instagram {!instagramConnected && <span className="text-muted-foreground">(non connecté)</span>}
                {instagramConnected && !servedInstagram && igContentType && (
                  <Badge variant="outline" className="ml-2 text-xs">
                    {IG_CONTENT_TYPE_LABELS[igContentType]}
                  </Badge>
                )}
              </Label>
            </div>
            {servedInstagram && (
              <p className="ml-6 text-[11.5px] text-muted-foreground">
                Déjà publié sur Instagram — ne sera pas republié.
              </p>
            )}
            {targetInstagram && !servedInstagram && selectedMedia.length === 1 && (
              <div className="ml-6 flex items-center gap-2">
                <Checkbox
                  id="target-instagram-story"
                  checked={targetInstagramStory}
                  onCheckedChange={(checked) => setTargetInstagramStory(checked === true)}
                />
                <Label htmlFor="target-instagram-story" className="text-[13.5px] font-normal text-muted-foreground">
                  Publier en Story plutôt qu'en {mediaMeta[0]?.isVideo ? "Reel" : "post"}
                </Label>
              </div>
            )}
          </div>
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Checkbox
                id="target-tiktok"
                checked={tiktokChecked}
                disabled={tiktokDisabled}
                onCheckedChange={(checked) => setTargetTiktok(checked === true)}
              />
              <Label htmlFor="target-tiktok" className="text-[13.5px] font-normal">
                TikTok{" "}
                {!tiktokConnected && <span className="text-muted-foreground">(non connecté)</span>}
                {tiktokConnected && !servedTiktok && tiktokContentType === null && selectedMedia.length > 0 && (
                  <span className="text-muted-foreground">(1 vidéo seule, ou uniquement des photos)</span>
                )}
                {tiktokConnected && !servedTiktok && tiktokContentType === "TIKTOK_VIDEO" && (
                  <span className="text-muted-foreground">— publié en brouillon (à finaliser dans l'app TikTok)</span>
                )}
                {tiktokConnected && !servedTiktok && tiktokContentType === "TIKTOK_PHOTO" && (
                  <span className="text-muted-foreground">— post photo, en brouillon</span>
                )}
              </Label>
            </div>
            {servedTiktok && (
              <p className="ml-6 text-[11.5px] text-muted-foreground">Déjà envoyé en brouillon TikTok.</p>
            )}
          </div>
        </div>

        {targetInstagram && !servedInstagram && igContentType === "REEL" && selectedMedia[0]?.isVideo && (
          <CoverFramePicker
            key={selectedMedia[0].id}
            videoUrl={selectedMedia[0].url}
            valueMs={coverTimeMs}
            onChange={setCoverTimeMs}
          />
        )}

        {!isEditingExisting && (
          <div className="space-y-2.5 rounded-lg border border-border p-3">
            <div className="space-y-1.5">
              <Label htmlFor="composer-schedule" className="text-xs font-semibold">
                Programmation ({timezone})
              </Label>
              <Input
                id="composer-schedule"
                type="datetime-local"
                value={dateTime}
                onChange={(e) => updateDateTime(e.target.value)}
              />
            </div>
            <div className="flex flex-wrap gap-1.5">
              <Button type="button" variant="outline" size="sm" onClick={() => updateDateTime(tomorrowLocalAt(12, timezone))}>
                Demain 12h
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => updateDateTime(tomorrowLocalAt(18, timezone))}>
                Demain 18h
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => updateDateTime(inOneHourLocal(timezone))}>
                Dans 1 h
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => updateDateTime("")}>
                Brouillon seulement
              </Button>
            </div>
            <p className="text-[11.5px] text-muted-foreground">
              Laissez vide pour enregistrer un simple brouillon (vous le programmerez plus tard).
            </p>
            {quietWarning && (
              <div className="flex flex-col gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-[12.5px] text-amber-700 dark:text-amber-400 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-start gap-2">
                  <Moon className="mt-0.5 size-4 shrink-0" />
                  <p>{QUIET_WINDOW_LABEL}</p>
                </div>
                <Button type="button" variant="outline" size="sm" onClick={shiftToWakeTime} className="shrink-0">
                  Décaler à 7h10
                </Button>
              </div>
            )}
          </div>
        )}

        {isEditingExisting ? (
          <Button onClick={() => submit("draft")} disabled={isPending || mediaAssetIds.length === 0} className="w-full sm:w-auto">
            {isPending ? "Enregistrement…" : "Enregistrer le brouillon"}
          </Button>
        ) : (
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button onClick={() => submit("schedule")} disabled={isPending || mediaAssetIds.length === 0} className="w-full sm:w-auto">
              {primaryLabel}
            </Button>
            <Button
              variant="outline"
              onClick={() => submit("draft")}
              disabled={isPending || mediaAssetIds.length === 0}
              className="w-full sm:w-auto"
            >
              Enregistrer comme brouillon
            </Button>
          </div>
        )}
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

/**
 * Sélecteur de la frame de couverture d'un Reel Instagram (thumb_offset). L'utilisateur scrube la
 * vidéo ; la frame choisie (en ms) servira de couverture — la même seconde peut être choisie sur
 * TikTok au moment de finaliser pour une couverture identique sur les deux plateformes.
 */
function CoverFramePicker({
  videoUrl,
  valueMs,
  onChange,
}: {
  videoUrl: string;
  valueMs: number | null;
  onChange: (ms: number) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [duration, setDuration] = useState(0);

  function handleLoadedMetadata() {
    const v = videoRef.current;
    if (!v) return;
    setDuration(v.duration || 0);
    v.currentTime = valueMs != null ? Math.min(valueMs / 1000, v.duration || 0) : 0;
  }

  function handleSeek(seconds: number) {
    const v = videoRef.current;
    if (v) v.currentTime = seconds;
    onChange(Math.round(seconds * 1000));
  }

  return (
    <div className="space-y-2 rounded-lg border border-border p-3">
      <Label className="text-xs font-semibold">Couverture du Reel</Label>
      <div className="flex gap-3">
        <video
          ref={videoRef}
          src={videoUrl}
          muted
          playsInline
          preload="metadata"
          onLoadedMetadata={handleLoadedMetadata}
          className="aspect-9/16 w-20 shrink-0 rounded-md bg-muted object-cover"
        />
        <div className="flex-1 space-y-1.5">
          <input
            type="range"
            min={0}
            max={duration || 0}
            step={0.1}
            value={valueMs != null ? valueMs / 1000 : 0}
            onChange={(e) => handleSeek(Number(e.target.value))}
            disabled={duration === 0}
            className="w-full accent-primary"
            aria-label="Position de la frame de couverture"
          />
          <p className="text-[11.5px] text-muted-foreground">
            Frame à <span className="font-semibold tabular-nums">{((valueMs ?? 0) / 1000).toFixed(1)} s</span>
            {duration > 0 && ` / ${duration.toFixed(1)} s`} — choisissez la même seconde sur TikTok pour une couverture identique.
          </p>
        </div>
      </div>
    </div>
  );
}

function PreviewMock({ media, extraCount, caption }: { media: MediaOption | null; extraCount: number; caption: string }) {
  return (
    <Card className="mx-auto max-w-xs overflow-hidden py-0">
      <div className="relative flex aspect-9/16 items-center justify-center bg-muted">
        {media ? (
          media.thumbnailUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={media.thumbnailUrl} alt="" className="size-full object-cover" />
          ) : media.isVideo ? (
            <FileVideo className="size-10 text-muted-foreground" />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={media.url} alt="" className="size-full object-cover" />
          )
        ) : (
          <p className="p-4 text-center text-[13.5px] text-muted-foreground">Sélectionnez un média</p>
        )}
        {extraCount > 0 && (
          <Badge className="absolute right-2 top-2" variant="secondary">
            +{extraCount}
          </Badge>
        )}
      </div>
      <CardContent className="py-3">
        <p className="whitespace-pre-wrap text-[11.5px] text-muted-foreground">{caption || "Votre légende apparaîtra ici."}</p>
      </CardContent>
    </Card>
  );
}
