"use server";

import { verifySession } from "@/lib/dal";
import { db } from "@/lib/db";
import {
  checkTikTokDraftCapacity,
  getInstagramQuotaSnapshot,
  TIKTOK_MAX_PENDING_DRAFTS_24H,
} from "@/lib/quota";

/**
 * Server Action LECTURE SEULE du LOT L5 : pré-affiche l'état des quotas sur la page « Publication en
 * masse » AVANT toute soumission. N'écrit RIEN (aucune création de post/target/job) — elle se
 * contente de lire la capacité TikTok (brouillons en attente sur 24 h) et un snapshot du quota
 * Instagram, pour que l'UI affiche « X brouillon(s) TikTok — il vous en reste Y sur 5 » et prévienne
 * si le lot courant dépasserait.
 *
 * Distincte de actions/bulk.ts (qui, elle, programme réellement) : ce module ne touche jamais à la
 * base en écriture et peut être appelé au chargement de la page sans effet de bord.
 */

export type BulkQuotaInfo = {
  tiktok: {
    /** Brouillons TikTok déjà en attente sur la fenêtre de 24 h. */
    current: number;
    /** Places restantes (max - current, borné à 0). */
    remaining: number;
    /** Plafond documenté TikTok (5). */
    max: number;
  };
  instagram: {
    /** Quota lu en runtime via content_publishing_limit ; null si compte absent/erreur API. */
    snapshot: { used: number; total: number } | null;
    /** Vrai si un compte Instagram est connecté (indépendamment du succès de l'appel quota). */
    connected: boolean;
  };
};

/**
 * Renvoie l'état des quotas pour l'utilisateur courant. Tolérant : si aucun compte TikTok/Instagram
 * n'est connecté, les valeurs restent cohérentes (capacité pleine côté TikTok, snapshot null côté
 * Instagram). Ne jette jamais pour l'affichage.
 */
export async function getBulkQuotaInfo(): Promise<BulkQuotaInfo> {
  const session = await verifySession();

  // Capacité TikTok : scope « tous les comptes TikTok de l'utilisateur » (aligné sur le pré-check du
  // scheduler en masse). additionalDrafts = 0 → on veut juste l'état actuel, pas une réservation.
  const capacity = await checkTikTokDraftCapacity({ userId: session.userId }, 0);

  const igAccount = await db.socialAccount.findFirst({
    where: { userId: session.userId, platform: "INSTAGRAM" },
    select: { id: true },
  });

  const igSnapshot = igAccount ? await getInstagramQuotaSnapshot(igAccount.id) : null;

  return {
    tiktok: {
      current: capacity.current,
      remaining: capacity.remaining,
      max: TIKTOK_MAX_PENDING_DRAFTS_24H,
    },
    instagram: {
      snapshot: igSnapshot,
      connected: Boolean(igAccount),
    },
  };
}
