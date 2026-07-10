"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Layers, Info, Plus, Loader2, Moon } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
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
  validateCard,
  localToIso,
  localToMs,
  effectiveTiktokTimeMs,
  cardQuietWindowFields,
} from "@/lib/bulk-ui";
import { maxCountInSlidingWindow, TIKTOK_WINDOW_MS } from "@/lib/tiktok-window";
import { QUIET_WINDOW_LABEL } from "@/lib/schedule-window";
import { scheduleManyPostsAction, type ScheduleManyInput } from "@/lib/actions/bulk";
import type { BulkQuotaInfo } from "@/lib/actions/bulk-info";
import { getLastUsed, rememberHashtags, truncatePreview } from "@/lib/last-used";

/** Clé sessionStorage versionnée (P2-6a) : bump la version (« -v2 », …) si le format change un jour. */
const BULK_DRAFT_STORAGE_KEY = "bulk-draft-v1";

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
    timeTouched: false,
    result: { status: "idle" },
  };
}

// -----------------------------------------------------------------------------
// Persistance sessionStorage du lot en cours de saisie (P2-6a)
// -----------------------------------------------------------------------------
//
// Seules les cartes NON PROGRAMMÉES et les réglages du lot sont persistés (jamais `result` : un
// succès/échec de soumission ne doit pas survivre à un rechargement). Validation défensive à la
// lecture (sessionStorage est hors du contrôle de TypeScript) : toute entrée malformée est ignorée
// plutôt que de faire planter la page.

type PersistedBulkCard = {
  mediaAssetId: string;
  name: string;
  url: string;
  thumbnailUrl: string | null;
  isVideo: boolean;
  caption: string;
  hashtagsText: string;
  platforms: { tiktok: boolean; instagram: boolean };
  dateTime: string;
  tiktokTime: string;
  instagramTime: string;
};

type PersistedBulkDraft = {
  cards: PersistedBulkCard[];
  offsetEnabled: boolean;
  manualMode: "simultaneous" | "custom";
  groupCaption: string;
  groupHashtags: string;
  startTime: string;
  intervalMinutes: number;
};

function isPersistedBulkCard(value: unknown): value is PersistedBulkCard {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  const platforms = v.platforms as Record<string, unknown> | undefined;
  return (
    typeof v.mediaAssetId === "string" &&
    typeof v.name === "string" &&
    typeof v.url === "string" &&
    (v.thumbnailUrl === null || typeof v.thumbnailUrl === "string") &&
    typeof v.isVideo === "boolean" &&
    typeof v.caption === "string" &&
    typeof v.hashtagsText === "string" &&
    typeof platforms === "object" &&
    platforms !== null &&
    typeof platforms.tiktok === "boolean" &&
    typeof platforms.instagram === "boolean" &&
    typeof v.dateTime === "string" &&
    typeof v.tiktokTime === "string" &&
    typeof v.instagramTime === "string"
  );
}

/** Parse défensif d'un brouillon sessionStorage : renvoie null si le JSON est absent/corrompu/hors-forme. */
function parseBulkDraft(raw: string): PersistedBulkDraft | null {
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    if (!data || typeof data !== "object" || !Array.isArray(data.cards)) return null;
    return {
      cards: data.cards.filter(isPersistedBulkCard),
      offsetEnabled: typeof data.offsetEnabled === "boolean" ? data.offsetEnabled : true,
      manualMode: data.manualMode === "custom" ? "custom" : "simultaneous",
      groupCaption: typeof data.groupCaption === "string" ? data.groupCaption : "",
      groupHashtags: typeof data.groupHashtags === "string" ? data.groupHashtags : "",
      startTime: typeof data.startTime === "string" ? data.startTime : defaultDateTime(),
      intervalMinutes: typeof data.intervalMinutes === "number" ? data.intervalMinutes : 10,
    };
  } catch {
    return null;
  }
}

function cardFromPersisted(p: PersistedBulkCard): BulkCardState {
  cardCounter += 1;
  return {
    key: `card-${cardCounter}`,
    mediaAssetId: p.mediaAssetId,
    name: p.name,
    url: p.url,
    thumbnailUrl: p.thumbnailUrl,
    isVideo: p.isVideo,
    caption: p.caption,
    hashtagsText: p.hashtagsText,
    platforms: p.platforms,
    dateTime: p.dateTime,
    tiktokTime: p.tiktokTime,
    instagramTime: p.instagramTime,
    timeTouched: false,
    result: { status: "idle" },
  };
}

export function BulkComposer({
  libraryMedia,
  instagramConnected,
  tiktokConnected,
  initialQuota,
  timezone,
}: {
  libraryMedia: LibraryMedia[];
  instagramConnected: boolean;
  tiktokConnected: boolean;
  initialQuota: BulkQuotaInfo;
  /** Fuseau de l'utilisateur (User.timezone, replié sur Europe/Paris — P3-5b). */
  timezone: string;
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

  // Persistance sessionStorage (P2-6a) ---------------------------------------
  // `hydrated` ne devient vrai qu'APRÈS la tentative de restauration (voir effet ci-dessous) : tant
  // qu'il est faux, l'effet de sauvegarde reste inactif — sinon l'état initial (vide) écraserait un
  // brouillon existant avant même d'avoir pu le lire.
  const [hydrated, setHydrated] = useState(false);
  const hasRestoredRef = useRef(false);

  useEffect(() => {
    if (hasRestoredRef.current) return;
    hasRestoredRef.current = true;
    try {
      const raw = sessionStorage.getItem(BULK_DRAFT_STORAGE_KEY);
      const draft = raw ? parseBulkDraft(raw) : null;
      if (draft) {
        const libraryIds = new Set(libraryMedia.map((m) => m.id));
        const seen = new Set<string>();
        const restored: BulkCardState[] = [];
        for (const p of draft.cards) {
          // Filtre les cartes dont le média a été supprimé depuis, et déduplique par sécurité.
          if (!libraryIds.has(p.mediaAssetId) || seen.has(p.mediaAssetId)) continue;
          seen.add(p.mediaAssetId);
          restored.push(cardFromPersisted(p));
        }
        if (restored.length > 0) setCards(restored);
        setOffsetEnabled(draft.offsetEnabled);
        setManualMode(draft.manualMode);
        setGroupCaption(draft.groupCaption);
        setGroupHashtags(draft.groupHashtags);
        setStartTime(draft.startTime);
        setIntervalMinutes(draft.intervalMinutes);
      }
    } catch {
      // sessionStorage indisponible (mode privé strict…) : page vierge, pas bloquant.
    } finally {
      setHydrated(true);
    }
  }, [libraryMedia]);

  useEffect(() => {
    if (!hydrated) return;
    const pending = cards.filter((c) => c.result.status !== "scheduled");
    try {
      if (pending.length === 0) {
        // Rien à conserver (lot vidé, ou entièrement programmé avec succès) : nettoyage complet.
        sessionStorage.removeItem(BULK_DRAFT_STORAGE_KEY);
        return;
      }
      const draft: PersistedBulkDraft = {
        cards: pending.map((c) => ({
          mediaAssetId: c.mediaAssetId,
          name: c.name,
          url: c.url,
          thumbnailUrl: c.thumbnailUrl,
          isVideo: c.isVideo,
          caption: c.caption,
          hashtagsText: c.hashtagsText,
          platforms: c.platforms,
          dateTime: c.dateTime,
          tiktokTime: c.tiktokTime,
          instagramTime: c.instagramTime,
        })),
        offsetEnabled,
        manualMode,
        groupCaption,
        groupHashtags,
        startTime,
        intervalMinutes,
      };
      sessionStorage.setItem(BULK_DRAFT_STORAGE_KEY, JSON.stringify(draft));
    } catch {
      // Quota dépassé / mode privé strict : simple confort perdu, jamais bloquant pour l'utilisateur.
    }
  }, [cards, offsetEnabled, manualMode, groupCaption, groupHashtags, startTime, intervalMinutes, hydrated]);

  // Mémoire de saisie (P2-5b) : derniers hashtags mémorisés, lus seulement une fois la tentative de
  // restauration sessionStorage terminée (`hydrated`) — priorité claire brouillon > mémoire > vide,
  // cf. `showReuseGroupHashtagsChip` plus bas : si le brouillon a restauré des hashtags communs, le
  // champ n'est plus vide et la puce ne s'affichera pas. Lire localStorage pendant le rendu initial
  // casserait aussi l'hydratation (localStorage n'existe pas côté serveur — voir last-used.ts).
  const [lastUsedHashtags, setLastUsedHashtags] = useState<string | null>(null);
  useEffect(() => {
    if (!hydrated) return;
    const stored = getLastUsed();
    if (stored?.hashtags) setLastUsedHashtags(stored.hashtags);
  }, [hydrated]);

  const igRemaining = initialQuota.instagram.snapshot
    ? Math.max(0, initialQuota.instagram.snapshot.total - initialQuota.instagram.snapshot.used)
    : null;

  // Nombre de cartes ciblant TikTok/Instagram (non encore programmées) que ce lot ajoutera.
  const pendingCards = cards.filter((c) => c.result.status !== "scheduled");
  const tiktokInBatch = pendingCards.filter((c) => c.platforms.tiktok).length;
  const igInBatch = pendingCards.filter((c) => c.platforms.instagram).length;

  // Compteur TikTok FENÊTRÉ (P1-4) : fusionne les brouillons existants (initialQuota) avec l'horaire
  // TikTok effectif de chaque carte en attente, puis cherche la fenêtre glissante de 24 h la plus
  // chargée — comme le pré-check serveur (bulk-scheduler.ts::precheckTikTokWindow), qui reste
  // l'autorité finale à la soumission. Un lot étalé sur plusieurs jours n'est donc plus bloqué à tort
  // par une comparaison au nombre total du lot.
  const newTiktokTimesMs = pendingCards
    .map((c) => effectiveTiktokTimeMs(c, timingMode, timezone))
    .filter((ms): ms is number => ms !== null);
  const tiktokBusiestCount = maxCountInSlidingWindow(
    [...initialQuota.tiktok.tiktokEventTimesMs, ...newTiktokTimesMs],
    TIKTOK_WINDOW_MS
  );
  const tiktokWouldExceed = tiktokBusiestCount > initialQuota.tiktok.max;
  const igWouldExceed = igRemaining !== null && igInBatch > igRemaining;

  // Avertissement fenêtre morte 23h-7h (P1-3, non bloquant) : cartes en attente ayant au moins un
  // horaire effectif dans le créneau où le service dort.
  const quietCardsCount = pendingCards.filter(
    (c) => cardQuietWindowFields(c, timingMode, timezone).length > 0
  ).length;

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
    // L'URL publique est résolue côté serveur à la finalisation de l'upload (route /complete) : la
    // carte affiche donc directement l'aperçu réel au lieu d'une tuile anonyme (voir BulkCard).
    addMedia({
      mediaAssetId: media.mediaAssetId,
      name: media.fileName,
      url: media.publicUrl,
      thumbnailUrl: null,
      isVideo: media.isVideo,
    });
  }

  /** « Heure de départ » (P2-6b) : ne synchronise QUE les cartes en attente pas encore éditées manuellement. */
  function handleStartTimeChange(value: string) {
    setStartTime(value);
    setCards((prev) =>
      prev.map((c) =>
        c.result.status === "scheduled" || c.timeTouched
          ? c
          : { ...c, dateTime: value, tiktokTime: value, instagramTime: value }
      )
    );
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
        // « Espacer » écrase TOUT sans condition (contrairement à la sync « Heure de départ ») et
        // remet timeTouched à false : un futur changement de « Heure de départ » pourra de nouveau
        // resynchroniser ces cartes tant qu'elles ne sont pas rééditées individuellement.
        return { ...c, dateTime: t, tiktokTime: t, instagramTime: t, timeTouched: false };
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
        const tkMs = card.platforms.tiktok ? localToMs(card.tiktokTime, timezone) : Number.POSITIVE_INFINITY;
        const igMs = card.platforms.instagram ? localToMs(card.instagramTime, timezone) : Number.POSITIVE_INFINITY;
        const earliest = Math.min(tkMs, igMs);
        baseIso = Number.isFinite(earliest) ? new Date(earliest).toISOString() : null;
        customTimes = {
          tiktok: card.platforms.tiktok ? localToIso(card.tiktokTime, timezone) ?? undefined : undefined,
          instagram: card.platforms.instagram ? localToIso(card.instagramTime, timezone) ?? undefined : undefined,
        };
      } else {
        baseIso = localToIso(card.dateTime, timezone);
      }

      // Validation client (miroir des règles serveur, marge de 2 min).
      const scheduledMs =
        timingMode === "custom"
          ? Math.min(
              card.platforms.tiktok ? localToMs(card.tiktokTime, timezone) : Number.POSITIVE_INFINITY,
              card.platforms.instagram ? localToMs(card.instagramTime, timezone) : Number.POSITIVE_INFINITY
            )
          : localToMs(card.dateTime, timezone);

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
        // Mémoire de saisie (P2-5b) : au moins une publication du lot est passée, on retient les
        // hashtags communs (rememberHashtags ignore déjà une chaîne vide, voir last-used.ts).
        rememberHashtags(groupHashtags);
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

  // Puce « Réutiliser les derniers hashtags » (P2-5b) : seulement une fois la restauration
  // sessionStorage tentée (`hydrated`, évite un flash), si le champ est ENCORE vide (un brouillon
  // restauré non vide le remplit déjà — priorité brouillon > mémoire, voir l'effet ci-dessus) et
  // qu'une mémoire existe.
  const showReuseGroupHashtagsChip = hydrated && groupHashtags.trim() === "" && Boolean(lastUsedHashtags);

  return (
    <div className="space-y-6">
      {/* 1. Ajout de vidéos : upload + sélection depuis la médiathèque */}
      <Card className="gap-0 py-0">
        <h3 className="border-b border-border px-[15px] py-3 text-[13.5px] font-semibold">Ajouter des vidéos</h3>
        <CardContent className="space-y-4 py-3.5">
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
      <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2.5 text-[12.5px] text-muted-foreground">
        <Info className="mt-0.5 size-4 shrink-0" />
        <p>
          En mode brouillon TikTok, la légende n'est <span className="font-semibold text-foreground">pas transmise</span> à
          l'application : utilisez le bouton <span className="font-semibold text-foreground">Copier</span> de chaque carte,
          puis collez-la dans TikTok au moment de finaliser la publication.
        </p>
      </div>

      {/* 2. Réglages du lot */}
      {hasCards && (
        <Card className="gap-0 py-0">
          <h3 className="border-b border-border px-[15px] py-3 text-[13.5px] font-semibold">Réglages du lot</h3>
          <CardContent className="space-y-6 py-3.5">
            {/* (a) Intervalle entre plateformes */}
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Checkbox
                  id="offset-enabled"
                  checked={offsetEnabled}
                  onCheckedChange={(checked) => setOffsetEnabled(checked === true)}
                />
                <Label htmlFor="offset-enabled" className="text-[13.5px] font-normal">
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
              <p className="text-[13.5px] font-semibold">Appliquer à toutes les cartes</p>

              <div className="space-y-1.5">
                <Label htmlFor="group-caption" className="text-xs font-semibold">
                  Légende commune
                </Label>
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
                <div className="flex items-center justify-between">
                  <Label htmlFor="group-hashtags" className="text-xs font-semibold">
                    Hashtags communs
                  </Label>
                  {showReuseGroupHashtagsChip && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      title={truncatePreview(lastUsedHashtags!)}
                      onClick={() => setGroupHashtags(lastUsedHashtags!)}
                    >
                      Réutiliser les derniers hashtags
                    </Button>
                  )}
                </div>
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
                  <Label htmlFor="start-time" className="text-xs font-semibold">
                    Heure de départ
                  </Label>
                  <Input
                    id="start-time"
                    type="datetime-local"
                    value={startTime}
                    onChange={(e) => handleStartTimeChange(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="interval" className="text-xs font-semibold">
                    Espacer de (min)
                  </Label>
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
            <div className="space-y-2 border-t border-border pt-4 text-[12.5px]">
              <p className="text-muted-foreground">
                <span className="font-semibold text-foreground">{initialQuota.tiktok.current}</span> brouillon(s) TikTok en
                attente actuellement.
                {tiktokInBatch > 0 && (
                  <>
                    {" "}
                    Ce lot en ajoute <span className="font-semibold text-foreground">{tiktokInBatch}</span>.
                  </>
                )}
              </p>
              <p className={tiktokWouldExceed ? "text-destructive" : "text-muted-foreground"}>
                Journée la plus chargée :{" "}
                <span className="font-semibold text-foreground">{tiktokBusiestCount}</span> brouillon(s) sur max{" "}
                {initialQuota.tiktok.max}.
              </p>
              {tiktokWouldExceed && (
                <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  Une journée dépasserait le plafond de {initialQuota.tiktok.max} brouillons TikTok en attente.
                  Déplacez des vidéos sur un autre jour, réduisez le nombre de vidéos ciblant TikTok, ou
                  publiez/supprimez des brouillons depuis l'app TikTok avant de réessayer.
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
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-[13px] text-destructive">
          <p className="font-semibold">Lot non programmé</p>
          <p>{blockedMessage}</p>
        </div>
      )}
      {igWarning && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-[13px] text-amber-700 dark:text-amber-400">
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
              timezone={timezone}
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

      {/* Résumé fenêtre morte 23h-7h (P1-3, non bloquant) — au-dessus de la soumission */}
      {quietCardsCount > 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-[13px] text-amber-700 dark:text-amber-400">
          <Moon className="mt-0.5 size-4 shrink-0" />
          <p>
            {QUIET_WINDOW_LABEL} {quietCardsCount} vidéo{quietCardsCount > 1 ? "s" : ""} de ce lot{" "}
            {quietCardsCount > 1 ? "sont concernées" : "est concernée"}.
          </p>
        </div>
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
            <span className="text-xs text-destructive">Déplacez des vidéos sur un autre jour pour continuer.</span>
          )}
        </div>
      )}
    </div>
  );
}
