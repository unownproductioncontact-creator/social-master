"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { fromZonedTime } from "date-fns-tz";
import { Layers, Info, Plus, Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { EmptyState } from "@/components/ui/empty-state";
import { MediaUploader, type UploadedMedia } from "@/components/library/media-uploader";
import { BulkCard, type BulkCardState, type TimingUiMode } from "@/components/bulk/bulk-card";
import { BulkMediaPicker, type LibraryMedia } from "@/components/bulk/bulk-media-picker";
import {
  splitHashtags,
  joinHashtags,
  applyGroupHashtags,
  computeSpacedTimes,
  isValidDateTimeLocal,
  validateCard,
} from "@/lib/bulk-ui";
import { scheduleManyPostsAction, type ScheduleManyInput } from "@/lib/actions/bulk";
import type { BulkQuotaInfo } from "@/lib/actions/bulk-info";

const TIMEZONE = "Europe/Paris";

/** Valeur datetime-local par défaut : dans 1 h, arrondie à la minute. */
function defaultDateTime(): string {
  const dt = new Date(Date.now() + 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
}

let cardCounter = 0;
function makeCard(
  media: { mediaAssetId: string; name: string; url: string; thumbnailUrl: string | null; isVideo: boolean },
  base: string,
  defaults: { tiktok: boolean; instagram: boolean }
): BulkCardState {
  cardCounter += 1;
  return {
    key: `card-${cardCounter}`,
    mediaAssetId: media.mediaAssetId,
    name: media.name,
    url: media.url,
    thumbnailUrl: media.thumbnailUrl,
    isVideo: media.isVideo,
    caption: "",
    hashtagsText: "",
    platforms: { tiktok: defaults.tiktok, instagram: defaults.instagram },
    dateTime: base,
    tiktokTime: base,
    instagramTime: base,
    result: { status: "idle" },
  };
}

/**
 * Convertit une chaîne datetime-local (heure murale dans TIMEZONE) en Date UTC via fromZonedTime,
 * puis en ISO string pour l'action serveur. Renvoie null si la chaîne est invalide.
 */
function localToIso(value: string): string | null {
  if (!isValidDateTimeLocal(value)) return null;
  const utc = fromZonedTime(value, TIMEZONE);
  if (Number.isNaN(utc.getTime())) return null;
  return utc.toISOString();
}

/** Millisecondes UTC correspondant à une chaîne datetime-local (dans TIMEZONE), ou NaN. */
function localToMs(value: string): number {
  const iso = localToIso(value);
  return iso ? new Date(iso).getTime() : Number.NaN;
}

export function BulkComposer({
  libraryMedia,
  instagramConnected,
  tiktokConnected,
  initialQuota,
}: {
  libraryMedia: LibraryMedia[];
  instagramConnected: boolean;
  tiktokConnected: boolean;
  initialQuota: BulkQuotaInfo;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  // Les deux plateformes cochées par défaut, mais seulement si connectées.
  const platformDefaults = { tiktok: tiktokConnected, instagram: instagramConnected };

  const [cards, setCards] = useState<BulkCardState[]>([]);

  // Réglages du lot ---------------------------------------------------------
  const [offsetEnabled, setOffsetEnabled] = useState(true);
  // Quand l'offset est décoché : simultané ou horaires personnalisés par plateforme.
  const [manualMode, setManualMode] = useState<"simultaneous" | "custom">("simultaneous");
  const timingMode: TimingUiMode = offsetEnabled ? "offset" : manualMode;

  const [groupCaption, setGroupCaption] = useState("");
  const [groupHashtags, setGroupHashtags] = useState("");
  const [startTime, setStartTime] = useState(defaultDateTime());
  const [intervalMinutes, setIntervalMinutes] = useState(10);

  // Résultat global de la dernière soumission.
  const [blockedMessage, setBlockedMessage] = useState<string | null>(null);
  const [igWarning, setIgWarning] = useState<string | null>(null);

  const igRemaining = initialQuota.instagram.snapshot
    ? Math.max(0, initialQuota.instagram.snapshot.total - initialQuota.instagram.snapshot.used)
    : null;

  // Nombre de cartes ciblant TikTok (non encore programmées) = brouillons TikTok que ce lot ajoutera.
  const pendingCards = cards.filter((c) => c.result.status !== "scheduled");
  const tiktokInBatch = pendingCards.filter((c) => c.platforms.tiktok).length;
  const igInBatch = pendingCards.filter((c) => c.platforms.instagram).length;
  const tiktokWouldExceed = tiktokInBatch > initialQuota.tiktok.remaining;
  const igWouldExceed = igRemaining !== null && igInBatch > igRemaining;

  // Mutation d'une carte ----------------------------------------------------
  function patchCard(key: string, patch: Partial<BulkCardState>) {
    setCards((prev) => prev.map((c) => (c.key === key ? { ...c, ...patch } : c)));
  }

  function removeCard(key: string) {
    setCards((prev) => prev.filter((c) => c.key !== key));
  }

  function addMedia(media: {
    mediaAssetId: string;
    name: string;
    url: string;
    thumbnailUrl: string | null;
    isVideo: boolean;
  }) {
    setCards((prev) => {
      // Évite les doublons : un même média déjà présent dans une carte non programmée n'est pas rajouté.
      if (prev.some((c) => c.mediaAssetId === media.mediaAssetId && c.result.status !== "scheduled")) {
        return prev;
      }
      return [...prev, makeCard(media, startTime, platformDefaults)];
    });
  }

  function handleUploaded(media: UploadedMedia) {
    // Un média fraîchement uploadé n'a pas d'URL d'aperçu résolue côté client (la clé de stockage
    // reste serveur) : on passe une url vide → la carte affiche l'icône vidéo/image (voir BulkCard).
    addMedia({
      mediaAssetId: media.mediaAssetId,
      name: media.fileName,
      url: "",
      thumbnailUrl: null,
      isVideo: media.isVideo,
    });
  }

  // Application groupée -----------------------------------------------------
  const editableKeys = () => cards.filter((c) => c.result.status !== "scheduled");

  function applyCaptionToAll() {
    setCards((prev) =>
      prev.map((c) => (c.result.status === "scheduled" ? c : { ...c, caption: groupCaption.slice(0, 2200) }))
    );
    toast.success("Légende appliquée à toutes les cartes.");
  }

  function applyHashtags(mode: "append" | "replace") {
    const common = splitHashtags(groupHashtags);
    setCards((prev) => {
      const editable = prev.filter((c) => c.result.status !== "scheduled");
      const applied = applyGroupHashtags(
        editable.map((c) => splitHashtags(c.hashtagsText)),
        common,
        mode
      );
      let i = 0;
      return prev.map((c) => {
        if (c.result.status === "scheduled") return c;
        const next = { ...c, hashtagsText: joinHashtags(applied[i]) };
        i += 1;
        return next;
      });
    });
    toast.success(mode === "append" ? "Hashtags ajoutés à toutes les cartes." : "Hashtags remplacés sur toutes les cartes.");
  }

  function applySpacing() {
    const editable = editableKeys();
    const result = computeSpacedTimes(startTime, intervalMinutes, editable.length);
    if ("error" in result) {
      toast.error(result.error);
      return;
    }
    setCards((prev) => {
      let i = 0;
      return prev.map((c) => {
        if (c.result.status === "scheduled") return c;
        const t = result.times[i];
        i += 1;
        // En mode custom, on remplit aussi les deux horaires par plateforme avec l'horaire espacé.
        return { ...c, dateTime: t, tiktokTime: t, instagramTime: t };
      });
    });
    toast.success("Horaires espacés appliqués.");
  }

  // Soumission --------------------------------------------------------------
  function buildItems(): { items: ScheduleManyInput["items"]; error?: string } {
    const now = Date.now();
    const items: ScheduleManyInput["items"] = [];

    for (const card of pendingCards) {
      // Résout l'horaire de base et les horaires par plateforme selon le mode.
      let baseIso: string | null;
      let customTimes: { tiktok?: string; instagram?: string } | undefined;

      if (timingMode === "custom") {
        const tkMs = card.platforms.tiktok ? localToMs(card.tiktokTime) : Number.POSITIVE_INFINITY;
        const igMs = card.platforms.instagram ? localToMs(card.instagramTime) : Number.POSITIVE_INFINITY;
        const earliest = Math.min(tkMs, igMs);
        baseIso = Number.isFinite(earliest) ? new Date(earliest).toISOString() : null;
        customTimes = {
          tiktok: card.platforms.tiktok ? localToIso(card.tiktokTime) ?? undefined : undefined,
          instagram: card.platforms.instagram ? localToIso(card.instagramTime) ?? undefined : undefined,
        };
      } else {
        baseIso = localToIso(card.dateTime);
      }

      // Validation client (miroir des règles serveur, marge de 2 min).
      const scheduledMs =
        timingMode === "custom"
          ? Math.min(
              card.platforms.tiktok ? localToMs(card.tiktokTime) : Number.POSITIVE_INFINITY,
              card.platforms.instagram ? localToMs(card.instagramTime) : Number.POSITIVE_INFINITY
            )
          : localToMs(card.dateTime);

      const validationError = validateCard(
        {
          mediaCount: 1,
          caption: card.caption,
          platforms: card.platforms,
          scheduledMs,
        },
        now
      );
      if (validationError) {
        return { items: [], error: `« ${card.name} » : ${validationError}` };
      }
      if (!baseIso) {
        return { items: [], error: `« ${card.name} » : horaire invalide.` };
      }

      items.push({
        mediaAssetIds: [card.mediaAssetId],
        caption: card.caption,
        hashtags: splitHashtags(card.hashtagsText),
        platforms: card.platforms,
        baseTime: baseIso,
        timing:
          timingMode === "offset"
            ? { mode: "offset" }
            : timingMode === "simultaneous"
              ? { mode: "simultaneous" }
              : { mode: "custom", customTimes },
      });
    }

    return { items };
  }

  function handleSubmit() {
    setBlockedMessage(null);
    setIgWarning(null);

    if (pendingCards.length === 0) {
      toast.error("Ajoutez au moins une vidéo à programmer.");
      return;
    }

    const { items, error } = buildItems();
    if (error) {
      toast.error(error);
      return;
    }

    startTransition(async () => {
      const result = await scheduleManyPostsAction({ items });

      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      if (result.blocked) {
        setBlockedMessage(result.message);
        toast.error("Lot bloqué : capacité TikTok insuffisante.");
        return;
      }

      // Applique les résultats PAR CARTE (dans l'ordre des cartes non programmées soumises).
      setCards((prev) => {
        let resultIdx = 0;
        return prev.map((c) => {
          if (c.result.status === "scheduled") return c;
          const r = result.results[resultIdx];
          resultIdx += 1;
          if (!r) return c;
          if (r.ok && r.postId) {
            return { ...c, result: { status: "scheduled" as const, postId: r.postId } };
          }
          return { ...c, result: { status: "failed" as const, message: r.error ?? "Échec de la programmation." } };
        });
      });

      if (result.igQuotaWarning) setIgWarning(result.igQuotaWarning);

      if (result.scheduled > 0) {
        toast.success(`${result.scheduled} publication(s) programmée(s).`);
      }
      if (result.failed > 0) {
        toast.error(`${result.failed} publication(s) en échec — voir le détail sur les cartes.`);
      }
      // Rafraîchit calendrier/dashboard côté données serveur.
      router.refresh();
    });
  }

  const alreadyPickedIds = useMemo(
    () => new Set(cards.filter((c) => c.result.status !== "scheduled").map((c) => c.mediaAssetId)),
    [cards]
  );

  const hasCards = cards.length > 0;

  return (
    <div className="space-y-6">
      {/* 1. Ajout de vidéos : upload + sélection depuis la médiathèque */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Ajouter des vidéos</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <MediaUploader onUploaded={handleUploaded} />
          {libraryMedia.length > 0 && (
            <BulkMediaPicker
              media={libraryMedia}
              pickedIds={alreadyPickedIds}
              onPick={(m) =>
                addMedia({
                  mediaAssetId: m.id,
                  name: m.name,
                  url: m.url,
                  thumbnailUrl: m.thumbnailUrl,
                  isVideo: m.isVideo,
                })
              }
            />
          )}
        </CardContent>
      </Card>

      {/* Avertissement TikTok PERMANENT (bandeau, pas un toast) */}
      <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        <Info className="mt-0.5 size-4 shrink-0" />
        <p>
          En mode brouillon TikTok, la légende n'est <span className="font-medium">pas transmise</span> à
          l'application : utilisez le bouton <span className="font-medium">Copier</span> de chaque carte,
          puis collez-la dans TikTok au moment de finaliser la publication.
        </p>
      </div>

      {/* 2. Réglages du lot */}
      {hasCards && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Réglages du lot</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* (a) Intervalle entre plateformes */}
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Checkbox
                  id="offset-enabled"
                  checked={offsetEnabled}
                  onCheckedChange={(checked) => setOffsetEnabled(checked === true)}
                />
                <Label htmlFor="offset-enabled" className="font-normal">
                  Publier TikTok d'abord, Instagram 5 min après
                </Label>
              </div>
              {!offsetEnabled && (
                <div className="ml-6 flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant={manualMode === "simultaneous" ? "default" : "outline"}
                    size="sm"
                    onClick={() => setManualMode("simultaneous")}
                  >
                    Publier simultanément
                  </Button>
                  <Button
                    type="button"
                    variant={manualMode === "custom" ? "default" : "outline"}
                    size="sm"
                    onClick={() => setManualMode("custom")}
                  >
                    Horaires personnalisés par plateforme
                  </Button>
                </div>
              )}
            </div>

            {/* (b) Application groupée */}
            <div className="space-y-4 border-t border-border pt-4">
              <p className="text-sm font-medium">Appliquer à toutes les cartes</p>

              <div className="space-y-1.5">
                <Label htmlFor="group-caption">Légende commune</Label>
                <Textarea
                  id="group-caption"
                  value={groupCaption}
                  rows={2}
                  placeholder="Légende à appliquer à toutes les vidéos…"
                  onChange={(e) => setGroupCaption(e.target.value.slice(0, 2200))}
                />
                <Button type="button" variant="outline" size="sm" onClick={applyCaptionToAll}>
                  Appliquer la légende à toutes
                </Button>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="group-hashtags">Hashtags communs</Label>
                <Input
                  id="group-hashtags"
                  value={groupHashtags}
                  placeholder="pokemon tcg boosters"
                  onChange={(e) => setGroupHashtags(e.target.value)}
                />
                <div className="flex flex-wrap gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={() => applyHashtags("append")}>
                    Ajouter aux hashtags existants
                  </Button>
                  <Button type="button" variant="outline" size="sm" onClick={() => applyHashtags("replace")}>
                    Remplacer les hashtags
                  </Button>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto] sm:items-end">
                <div className="space-y-1.5">
                  <Label htmlFor="start-time">Heure de départ</Label>
                  <Input
                    id="start-time"
                    type="datetime-local"
                    value={startTime}
                    onChange={(e) => setStartTime(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="interval">Espacer de (min)</Label>
                  <Input
                    id="interval"
                    type="number"
                    min={0}
                    className="w-28"
                    value={intervalMinutes}
                    onChange={(e) => setIntervalMinutes(Number(e.target.value))}
                  />
                </div>
                <Button type="button" variant="outline" size="sm" onClick={applySpacing}>
                  Espacer les vidéos
                </Button>
              </div>
            </div>

            {/* (c) Compteur de capacité TikTok + avertissements */}
            <div className="space-y-2 border-t border-border pt-4 text-sm">
              <p className={tiktokWouldExceed ? "text-destructive" : "text-muted-foreground"}>
                <span className="font-medium">{initialQuota.tiktok.current}</span> brouillon(s) TikTok en
                attente sur 24 h — il vous en reste{" "}
                <span className="font-medium">{initialQuota.tiktok.remaining}</span> sur{" "}
                {initialQuota.tiktok.max}.
                {tiktokInBatch > 0 && (
                  <>
                    {" "}
                    Ce lot en ajoute <span className="font-medium">{tiktokInBatch}</span>.
                  </>
                )}
              </p>
              {tiktokWouldExceed && (
                <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  Ce lot dépasserait le plafond de {initialQuota.tiktok.max} brouillons TikTok en attente.
                  Réduisez le nombre de vidéos ciblant TikTok, ou publiez/supprimez des brouillons depuis
                  l'app TikTok avant de réessayer.
                </p>
              )}
              {initialQuota.instagram.snapshot && (
                <p className={igWouldExceed ? "text-destructive" : "text-muted-foreground"}>
                  Quota Instagram : {initialQuota.instagram.snapshot.used}/
                  {initialQuota.instagram.snapshot.total} utilisées sur 24 h
                  {igInBatch > 0 && <> — ce lot en ajoute {igInBatch}.</>}
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Bandeaux de résultat global */}
      {blockedMessage && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <p className="font-medium">Lot non programmé</p>
          <p>{blockedMessage}</p>
        </div>
      )}
      {igWarning && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-400">
          {igWarning}
        </div>
      )}

      {/* 3. Liste des cartes (une par vidéo) */}
      {hasCards ? (
        <div className="space-y-4">
          {cards.map((card, index) => (
            <BulkCard
              key={card.key}
              card={card}
              index={index}
              timingMode={timingMode}
              tiktokConnected={tiktokConnected}
              instagramConnected={instagramConnected}
              disabled={isPending}
              onChange={(patch) => patchCard(card.key, patch)}
              onRemove={() => removeCard(card.key)}
            />
          ))}
        </div>
      ) : (
        <EmptyState
          icon={Layers}
          title="Ajoutez vos vidéos pour commencer"
          description="Importez plusieurs vidéos ci-dessus ou piochez dans votre médiathèque."
        />
      )}

      {/* 4. Soumission */}
      {hasCards && (
        <div className="flex items-center gap-3">
          <Button onClick={handleSubmit} disabled={isPending || pendingCards.length === 0 || tiktokWouldExceed}>
            {isPending ? (
              <>
                <Loader2 className="animate-spin" />
                Programmation…
              </>
            ) : (
              <>
                <Plus />
                Programmer {pendingCards.length} publication(s)
              </>
            )}
          </Button>
          {tiktokWouldExceed && (
            <span className="text-xs text-destructive">Réduisez les cibles TikTok pour continuer.</span>
          )}
        </div>
      )}
    </div>
  );
}
