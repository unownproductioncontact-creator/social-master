import "server-only";
import { db } from "@/lib/db";
import { decryptToken } from "@/lib/crypto";
import { getContentPublishingLimit } from "@/lib/providers/instagram";

/**
 * Garde-fous de quotas de publication (règle d'ingénierie n°5 : jamais de chiffre en dur pour
 * Instagram ; pour TikTok, un compteur local par compte/24h). Ce module ne bloque rien tout seul —
 * il fournit des vérifications et des snapshots que l'appelant (UI / action de programmation) utilise.
 */

// -----------------------------------------------------------------------------
// TikTok — plafond de brouillons en attente
// -----------------------------------------------------------------------------

/**
 * Plafond documenté par TikTok pour le mode brouillon (inbox) : au-delà, l'API renvoie
 * `spam_risk_too_many_pending_share`. Décision produit actée : dépassement = BLOCAGE EXPLICITE côté
 * app (pas d'étalement automatique). Voir CLAUDE.md §2 (« max 5 brouillons en attente / 24 h »).
 */
export const TIKTOK_MAX_PENDING_DRAFTS_24H = 5;

/** Identifie le périmètre du décompte : par compte TikTok précis, ou par utilisateur (tous ses comptes TikTok). */
export type TikTokDraftScope = { socialAccountId: string } | { userId: string };

/**
 * Compte les cibles TikTok en mode brouillon (`TIKTOK_DRAFT`) « en attente » sur une fenêtre glissante
 * de `windowHours` (24h par défaut). Deux composantes, additionnées :
 *
 *  1. Les brouillons À VENIR pas encore livrés : un `PublishJob` en état WAITING ou ACTIVE (les seuls
 *     états « pas encore terminés » du schéma — il n'existe pas de `CREATED`), dont le `runAt` tombe
 *     dans la fenêtre [maintenant ; maintenant + windowHours], rattaché à une cible TikTok en
 *     `TIKTOK_DRAFT`. Ils occuperont une place dans l'inbox une fois déclenchés.
 *  2. Les brouillons DÉJÀ LIVRÉS : une cible TikTok `TIKTOK_DRAFT` en statut `SENT_TO_INBOX` dont le
 *     `publishedAt` est dans la fenêtre [maintenant - windowHours ; maintenant].
 *
 * On compte des cibles distinctes : une même cible ne peut pas être à la fois SENT_TO_INBOX et avoir
 * un job WAITING/ACTIVE à venir (le job passe COMPLETED avant que le statut devienne SENT_TO_INBOX),
 * donc pas de double comptage entre les deux composantes.
 */
export async function countTikTokDraftsInWindow(
  scope: TikTokDraftScope,
  windowHours = 24
): Promise<number> {
  const now = Date.now();
  const windowMs = windowHours * 60 * 60 * 1000;
  const windowStart = new Date(now - windowMs);
  const windowEnd = new Date(now + windowMs);

  // Scoping (règle d'ingénierie n°10) : soit un compte TikTok précis, soit tous ceux d'un user.
  const accountFilter =
    "socialAccountId" in scope
      ? { socialAccountId: scope.socialAccountId }
      : { socialAccount: { userId: scope.userId } };

  const targetFilter = {
    platform: "TIKTOK" as const,
    publishMode: "TIKTOK_DRAFT" as const,
    ...accountFilter,
  };

  // 1. Brouillons à venir (jobs pas encore terminés, dont l'heure prévue tombe dans la fenêtre).
  const upcoming = await db.publishJob.count({
    where: {
      state: { in: ["WAITING", "ACTIVE"] },
      runAt: { gte: new Date(now), lte: windowEnd },
      postTarget: targetFilter,
    },
  });

  // 2. Brouillons déjà déposés dans l'inbox pendant la fenêtre écoulée.
  const alreadySent = await db.postTarget.count({
    where: {
      ...targetFilter,
      status: "SENT_TO_INBOX",
      publishedAt: { gte: windowStart },
    },
  });

  return upcoming + alreadySent;
}

export type TikTokDraftCapacity = {
  allowed: boolean;
  current: number;
  remaining: number;
  message?: string;
};

/**
 * Pré-vérifie s'il reste de la place pour `additionalDrafts` brouillon(s) TikTok (1 par défaut) dans
 * la fenêtre de 24h. `allowed=false` ⇒ l'appelant DOIT bloquer (décision produit : pas d'étalement
 * automatique). `message` est prêt à afficher tel quel dans l'UI (français, explicite).
 */
export async function checkTikTokDraftCapacity(
  scope: TikTokDraftScope,
  additionalDrafts = 1,
  windowHours = 24
): Promise<TikTokDraftCapacity> {
  const current = await countTikTokDraftsInWindow(scope, windowHours);
  const remaining = Math.max(0, TIKTOK_MAX_PENDING_DRAFTS_24H - current);
  const allowed = current + additionalDrafts <= TIKTOK_MAX_PENDING_DRAFTS_24H;

  if (allowed) return { allowed, current, remaining };

  const message =
    `TikTok limite à ${TIKTOK_MAX_PENDING_DRAFTS_24H} brouillons en attente par 24 h — vous en avez déjà ${current}` +
    (remaining > 0
      ? `, il ne reste que ${remaining} place${remaining > 1 ? "s" : ""}.`
      : ` (plafond atteint). Publiez ou supprimez un brouillon depuis l'app TikTok, puis réessayez.`);

  return { allowed, current, remaining, message };
}

// -----------------------------------------------------------------------------
// Instagram — quota de publication lu en runtime (jamais en dur)
// -----------------------------------------------------------------------------

export type InstagramQuotaSnapshot = { used: number; total: number };

/**
 * Snapshot du quota de publication Instagram pour un compte donné, lu en RUNTIME via l'API
 * `content_publishing_limit` (le total n'est JAMAIS codé en dur — voir règle d'ingénierie n°5 et
 * CLAUDE.md §2 : docs contradictoires 100 vs 50). Réutilise `getContentPublishingLimit` du provider
 * (pas de duplication).
 *
 * Tolérant aux erreurs : renvoie `null` si le compte est introuvable, n'est pas Instagram, ou si
 * l'appel API échoue — ce snapshot est un pré-contrôle NON bloquant côté IG (le vrai garde-fou reste
 * la lecture du quota au moment de publier, dans le worker). Ne jette jamais.
 */
export async function getInstagramQuotaSnapshot(
  socialAccountId: string
): Promise<InstagramQuotaSnapshot | null> {
  try {
    const account = await db.socialAccount.findUnique({ where: { id: socialAccountId } });
    if (!account || account.platform !== "INSTAGRAM") return null;

    const accessToken = decryptToken(account.accessTokenEnc);
    const { quotaUsage, quotaTotal } = await getContentPublishingLimit(account.platformAccountId, accessToken);
    return { used: quotaUsage, total: quotaTotal };
  } catch {
    return null;
  }
}
