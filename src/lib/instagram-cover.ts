/**
 * Couverture d'un Reel Instagram (CLAUDE.md §37) — module PUR, testé (instagram-cover.test.ts).
 *
 * Doc Meta (POST /{ig-user-id}/media, vérifiée le 13/10/2026) : `cover_url` = « For Reels only. The
 * path to an image to use as the cover image for the Reels tab », image JPEG ≤ 8 Mo téléchargée par
 * Meta (URL publique : notre Worker), 9:16 recommandé (sinon le rectangle 9:16 central est gardé) ;
 * « If you specify both cover_url and thumb_offset, we use cover_url and ignore thumb_offset ».
 * La page de référence décrit la connexion Facebook ; le guide « Instagram Login » ne cite pas
 * `cover_url` : à confirmer au premier vrai Reel. D'où les deux replis du worker : refus immédiat →
 * conteneur recréé sans couverture ; conteneur en échec → nouvel essai sans couverture.
 */

export type CoverResult = {
  /** cover_url = l'image choisie ; frame = une image de la vidéo (thumb_offset ou défaut Instagram). */
  applied: "cover_url" | "frame";
  mediaId?: string;
  thumbOffsetMs?: number;
  /** La couverture choisie a été refusée par Instagram : repli sur une frame. */
  reason?: "cover_refused";
  error?: string;
};

type CoverMedia = { id: string; storageKey: string; mimeType: string; status: string };

export type CoverPlan = {
  /** Image à envoyer en `cover_url` (null = aucune). */
  coverMedia: CoverMedia | null;
  thumbOffsetMs?: number;
  /** Ce qui sera journalisé si la publication réussit sans incident. */
  result?: CoverResult;
};

function readOptions(options: unknown): { coverTimeMs?: unknown; coverRefused?: unknown } {
  return typeof options === "object" && options !== null ? (options as { coverTimeMs?: unknown; coverRefused?: unknown }) : {};
}

/** Frame de couverture choisie (thumb_offset, ms) — lecture tolérante. */
export function coverTimeFromOptions(options: unknown): number | undefined {
  const raw = readOptions(options).coverTimeMs;
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? Math.round(raw) : undefined;
}

/** Ce qu'il faut envoyer à Instagram pour la couverture d'une cible. Hors Reel : rien. */
export function coverPlan(contentType: string, platformOptions: unknown, coverMedia: CoverMedia | null): CoverPlan {
  if (contentType !== "REEL") return { coverMedia: null };
  const thumbOffsetMs = coverTimeFromOptions(platformOptions);
  const refused = Boolean(readOptions(platformOptions).coverRefused);
  const usable = coverMedia && coverMedia.status === "READY" && coverMedia.mimeType.startsWith("image/") ? coverMedia : null;

  if (usable && !refused) {
    return { coverMedia: usable, thumbOffsetMs, result: { applied: "cover_url", mediaId: usable.id } };
  }
  if (usable && refused) {
    return { coverMedia: null, thumbOffsetMs, result: { applied: "frame", reason: "cover_refused", thumbOffsetMs } };
  }
  return { coverMedia: null, thumbOffsetMs, result: thumbOffsetMs != null ? { applied: "frame", thumbOffsetMs } : undefined };
}

/** Lecture tolérante de `detail.cover` d'une entrée du journal de publication (null si absent). */
export function readCoverResult(detail: unknown): CoverResult | null {
  if (typeof detail !== "object" || detail === null) return null;
  const raw = (detail as { cover?: unknown }).cover;
  if (typeof raw !== "object" || raw === null) return null;
  const applied = (raw as { applied?: unknown }).applied;
  if (applied !== "cover_url" && applied !== "frame") return null;
  return raw as CoverResult;
}
