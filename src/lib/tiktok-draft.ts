/**
 * Livraison d'un brouillon TikTok (inbox) SANS doublon (CLAUDE.md §27).
 *
 * Incident du 30/09/2026 : TikTok a mis ~15 min à traiter un envoi ; le worker abandonnait l'attente au
 * bout de 5 min, pg-boss relançait le job, et chaque tentative refaisait init + upload → 3 brouillons
 * identiques dans les notifications TikTok. Règle désormais : dès que TikTok détient le média (publish_id
 * connu et persisté), on ne renvoie JAMAIS le fichier — on reprend seulement la vérification du statut.
 *
 * Module PUR (dépendances injectées) pour être testé sans base ni réseau.
 */
import { TikTokPublishFailedError } from "@/lib/errors";
import type { TikTokPublishStatus } from "@/lib/providers/tiktok";

export type TikTokDraftDeps = {
  /** publish_id persisté par une tentative précédente (null = aucun envoi abouti). */
  existingPublishId: string | null;
  /** Init (+ upload pour une vidéo) → publish_id, une fois le média entièrement transmis. */
  start: () => Promise<string>;
  /** Persiste le publish_id (ou l'efface avec null). */
  savePublishId: (publishId: string | null) => Promise<void>;
  /** Attend la livraison dans la boîte de réception (lève TikTokStillProcessingError / TikTokPublishFailedError). */
  waitForInbox: (publishId: string) => Promise<void>;
};

export async function deliverTikTokDraft(deps: TikTokDraftDeps): Promise<void> {
  let publishId = deps.existingPublishId;
  if (!publishId) {
    publishId = await deps.start();
    // Persisté AVANT d'attendre : si l'attente expire ou si le process meurt, le retry reprendra ce
    // publish_id au lieu de renvoyer le média.
    await deps.savePublishId(publishId);
  }
  try {
    await deps.waitForInbox(publishId);
  } catch (err) {
    // FAILED = TikTok a abandonné cet envoi, aucun brouillon ne sera livré : un éventuel retry (erreur
    // « internal ») doit repartir d'un envoi neuf.
    if (err instanceof TikTokPublishFailedError) await deps.savePublishId(null);
    throw err;
  }
}

/** Au-delà, on arrête d'attendre la confirmation TikTok et on demande une vérification manuelle. */
export const TIKTOK_CONFIRMATION_MAX_AGE_MS = 2 * 60 * 60 * 1000;

export type TikTokPendingDecision = "delivered" | "failed" | "wait" | "expired";

/**
 * Décision de la réconciliation pour un brouillon TikTok transmis mais pas encore confirmé.
 * `status` null = statut illisible (réseau, jeton…) : on patiente jusqu'à l'échéance.
 */
export function decideTikTokPendingDraft(input: {
  status: TikTokPublishStatus | null;
  uploadedAt: Date;
  now: Date;
  maxAgeMs?: number;
}): TikTokPendingDecision {
  if (input.status === "SEND_TO_USER_INBOX" || input.status === "PUBLISH_COMPLETE") return "delivered";
  if (input.status === "FAILED") return "failed";
  const maxAgeMs = input.maxAgeMs ?? TIKTOK_CONFIRMATION_MAX_AGE_MS;
  return input.now.getTime() - input.uploadedAt.getTime() > maxAgeMs ? "expired" : "wait";
}
