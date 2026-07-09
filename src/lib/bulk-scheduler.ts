import "server-only";
import type { Platform } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { schedulePost, type TargetTimes } from "@/lib/scheduler";
import { checkTikTokDraftCapacity, getInstagramQuotaSnapshot } from "@/lib/quota";
import {
  checkInstagramCarouselCompatibility,
  checkTikTokPhotoCompatibility,
} from "@/lib/media-validation";
import {
  computeInstagramContentType,
  computeTikTokContentType,
  type InstagramContentType,
  type TikTokContentType,
} from "@/lib/content-type";

/**
 * LOT L4 — Création + programmation EN MASSE (côté serveur, sans UI).
 *
 * `scheduleManyPosts` crée puis programme plusieurs posts d'un coup. Deux garde-fous du reste du
 * projet sont respectés à la lettre :
 *   - PRÉ-CHECK GLOBAL de capacité TikTok AVANT toute écriture : si le lot dépasse le plafond de
 *     brouillons en attente (décision produit §2 : blocage EXPLICITE, pas d'étalement automatique),
 *     on retourne immédiatement sans rien créer.
 *   - UNE transaction PAR item (jamais de transaction géante inter-posts — règle d'ingénierie n°2 +
 *     pooler Supabase). Un échec sur un item n'annule NI n'empêche les autres.
 *
 * La logique métier de validation (comptes présents, compatibilité média par plateforme, type de
 * contenu) est identique à celle de `savePostDraft` : elle est factorisée dans
 * `buildValidatedTargetsForItem` ci-dessous, réutilisé par les deux chemins n'est pas possible sans
 * toucher au composer — on reprend donc la MÊME logique, alignée volontairement.
 */

// -----------------------------------------------------------------------------
// Calcul PUR des horaires effectifs par plateforme (testé unitairement)
// -----------------------------------------------------------------------------

export const DEFAULT_OFFSET_SECONDS = 300;

export type BulkTiming =
  | { mode: "offset"; offsetSeconds?: number }
  | { mode: "simultaneous" }
  | { mode: "custom"; customTimes?: { tiktok?: Date; instagram?: Date } };

export type SelectedPlatforms = { tiktok: boolean; instagram: boolean };

export type ComputeTargetTimesResult = { targetTimes: TargetTimes } | { error: string };

/**
 * Calcule l'horaire effectif de chaque plateforme cochée, à partir de l'horaire de base et du mode
 * de timing choisi. Fonction PURE (aucune I/O) — c'est le cœur testable du décalage horaire.
 *
 *  - `offset` : TikTok part à `baseTime`, Instagram à `baseTime + offsetSeconds` (défaut 300 s,
 *     l'ordre TikTok-d'abord est une décision produit §2). Si une SEULE plateforme est cochée, elle
 *     part à `baseTime` (pas d'offset appliqué à une plateforme seule).
 *  - `simultaneous` : les deux plateformes à `baseTime`.
 *  - `custom` : chaque plateforme cochée DOIT avoir un horaire fourni dans `customTimes` — sinon
 *     erreur (on n'invente pas d'horaire par défaut en mode custom).
 *
 * Ne renvoie une entrée dans `targetTimes` que pour les plateformes réellement cochées ; les autres
 * sont absentes (le scheduler retombe alors sur l'horaire de base, mais aucune cible n'existera pour
 * une plateforme non cochée de toute façon).
 */
export function computeTargetTimes(
  baseTime: Date,
  platforms: SelectedPlatforms,
  timing: BulkTiming
): ComputeTargetTimesResult {
  if (!platforms.tiktok && !platforms.instagram) {
    return { error: "Choisissez au moins une plateforme." };
  }
  if (Number.isNaN(baseTime.getTime())) {
    return { error: "Date de base invalide." };
  }

  const targetTimes: TargetTimes = {};

  switch (timing.mode) {
    case "simultaneous": {
      if (platforms.tiktok) targetTimes.TIKTOK = baseTime;
      if (platforms.instagram) targetTimes.INSTAGRAM = baseTime;
      return { targetTimes };
    }

    case "offset": {
      const offsetSeconds = timing.offsetSeconds ?? DEFAULT_OFFSET_SECONDS;
      if (!Number.isFinite(offsetSeconds) || offsetSeconds < 0) {
        return { error: "Décalage horaire invalide." };
      }
      const bothSelected = platforms.tiktok && platforms.instagram;
      if (platforms.tiktok) targetTimes.TIKTOK = baseTime;
      if (platforms.instagram) {
        // TikTok d'abord (à H), Instagram décalé (à H+offset) — mais uniquement si les DEUX sont
        // cochées ; une plateforme seule part à l'horaire de base.
        targetTimes.INSTAGRAM = bothSelected
          ? new Date(baseTime.getTime() + offsetSeconds * 1000)
          : baseTime;
      }
      return { targetTimes };
    }

    case "custom": {
      const custom = timing.customTimes ?? {};
      if (platforms.tiktok) {
        if (!custom.tiktok || Number.isNaN(custom.tiktok.getTime())) {
          return { error: "Horaire TikTok manquant ou invalide (mode personnalisé)." };
        }
        targetTimes.TIKTOK = custom.tiktok;
      }
      if (platforms.instagram) {
        if (!custom.instagram || Number.isNaN(custom.instagram.getTime())) {
          return { error: "Horaire Instagram manquant ou invalide (mode personnalisé)." };
        }
        targetTimes.INSTAGRAM = custom.instagram;
      }
      return { targetTimes };
    }
  }
}

// -----------------------------------------------------------------------------
// Programmation en masse
// -----------------------------------------------------------------------------

export type BulkItem = {
  mediaAssetIds: string[];
  caption: string;
  hashtags?: string[];
  platforms: SelectedPlatforms;
  baseTime: Date;
  timing: BulkTiming;
};

export type BulkItemResult = {
  index: number;
  ok: boolean;
  postId?: string;
  error?: string;
};

export type ScheduleManyOptions = {
  /** Fenêtre glissante du décompte de capacité TikTok (24 h par défaut, aligné sur quota.ts). */
  windowHours?: number;
};

export type ScheduleManyResult =
  | { blocked: true; message: string }
  | {
      blocked: false;
      results: BulkItemResult[];
      scheduled: number;
      failed: number;
      igQuotaWarning?: string;
    };

/**
 * Compte le nombre total de cibles TikTok en mode brouillon (`TIKTOK_DRAFT`) que ce lot va créer.
 * Seuls les items ciblant TikTok comptent : une cible TikTok = un futur brouillon inbox.
 */
function countTikTokDraftsInBatch(items: BulkItem[]): number {
  return items.reduce((total, item) => (item.platforms.tiktok ? total + 1 : total), 0);
}

/**
 * Valide un item et renvoie de quoi créer ses cibles (types de contenu + comptes résolus), OU une
 * erreur FR. Réplique EXACTEMENT la logique de validation de `savePostDraft` (même messages) pour
 * rester cohérent — sans y toucher (le composer existant ne doit pas changer de comportement).
 */
type ValidatedItem = {
  orderedMediaIds: string[];
  igContentType: InstagramContentType | null;
  tiktokContentType: TikTokContentType | null;
  instagramAccountId: string | null;
  tiktokAccountId: string | null;
};

async function validateItem(
  userId: string,
  item: BulkItem
): Promise<{ ok: true; value: ValidatedItem } | { ok: false; error: string }> {
  if (item.mediaAssetIds.length === 0) {
    return { ok: false, error: "Sélectionnez au moins un média." };
  }
  if (item.caption.length > 2200) {
    return { ok: false, error: "2200 caractères maximum." };
  }
  if (!item.platforms.tiktok && !item.platforms.instagram) {
    return { ok: false, error: "Choisissez au moins une plateforme." };
  }

  const mediaAssets = await db.mediaAsset.findMany({ where: { id: { in: item.mediaAssetIds } } });
  if (
    mediaAssets.length !== item.mediaAssetIds.length ||
    mediaAssets.some((m) => m.userId !== userId)
  ) {
    return { ok: false, error: "Média introuvable." };
  }
  // Conserve l'ordre choisi (findMany ne garantit pas l'ordre de la clause `in`).
  const orderedMedia = item.mediaAssetIds.map((id) => mediaAssets.find((m) => m.id === id)!);
  const mediaMeta = orderedMedia.map((m) => ({ isVideo: m.mimeType.startsWith("video/") }));

  // Le mode masse ne gère pas les Stories (pas de champ dédié dans un item) → wantsStory = false,
  // cohérent avec computeInstagramContentType (Reel/Image/Carrousel uniquement).
  const igContentType = item.platforms.instagram
    ? computeInstagramContentType(orderedMedia.length, mediaMeta[0].isVideo, false)
    : null;
  if (igContentType === "CAROUSEL") {
    const issues = checkInstagramCarouselCompatibility(orderedMedia.length);
    if (issues.length > 0) return { ok: false, error: issues[0].message };
  }

  const tiktokContentType = item.platforms.tiktok ? computeTikTokContentType(mediaMeta) : null;
  if (item.platforms.tiktok && tiktokContentType === null) {
    return {
      ok: false,
      error:
        "TikTok ne supporte pas cette combinaison de médias (une vidéo seule, ou une/plusieurs photos).",
    };
  }
  if (tiktokContentType === "TIKTOK_PHOTO") {
    const issues = checkTikTokPhotoCompatibility(orderedMedia.length);
    if (issues.length > 0) return { ok: false, error: issues[0].message };
  }

  const accounts = await db.socialAccount.findMany({ where: { userId } });
  const instagramAccount = accounts.find((a) => a.platform === "INSTAGRAM");
  const tiktokAccount = accounts.find((a) => a.platform === "TIKTOK");
  if (item.platforms.instagram && !instagramAccount) {
    return { ok: false, error: "Connectez d'abord votre compte Instagram." };
  }
  if (item.platforms.tiktok && !tiktokAccount) {
    return { ok: false, error: "Connectez d'abord votre compte TikTok." };
  }

  return {
    ok: true,
    value: {
      orderedMediaIds: orderedMedia.map((m) => m.id),
      igContentType,
      tiktokContentType,
      instagramAccountId: instagramAccount?.id ?? null,
      tiktokAccountId: tiktokAccount?.id ?? null,
    },
  };
}

/**
 * Crée et programme UN item dans SA PROPRE transaction (Post + PostMedia + PostTarget), puis appelle
 * `schedulePost` avec les horaires calculés. Ne jette jamais : renvoie `{ postId }` ou `{ error }`.
 *
 * `schedulePost` ouvre lui-même sa propre transaction (post → SCHEDULED + PublishJob + job pg-boss).
 * On ne l'imbrique donc PAS dans la transaction de création : on crée d'abord le brouillon, puis on
 * programme. Si la programmation échoue, on supprime le brouillon orphelin pour ne pas laisser de
 * DRAFT à moitié créé (comportement propre : soit l'item est programmé, soit rien ne subsiste).
 */
async function createAndScheduleItem(
  userId: string,
  item: BulkItem,
  validated: ValidatedItem
): Promise<{ postId: string } | { error: string }> {
  const timesResult = computeTargetTimes(item.baseTime, item.platforms, item.timing);
  if ("error" in timesResult) return { error: timesResult.error };

  let postId: string;
  try {
    const post = await db.$transaction(async (tx) => {
      const created = await tx.post.create({
        data: {
          userId,
          caption: item.caption,
          hashtags: item.hashtags ?? [],
          status: "DRAFT",
        },
      });

      await tx.postMedia.createMany({
        data: validated.orderedMediaIds.map((mediaAssetId, position) => ({
          postId: created.id,
          mediaAssetId,
          position,
        })),
      });

      if (item.platforms.instagram && validated.instagramAccountId && validated.igContentType) {
        await tx.postTarget.create({
          data: {
            postId: created.id,
            socialAccountId: validated.instagramAccountId,
            platform: "INSTAGRAM",
            contentType: validated.igContentType,
            publishMode: "AUTO",
            status: "PENDING",
          },
        });
      }
      if (item.platforms.tiktok && validated.tiktokAccountId && validated.tiktokContentType) {
        await tx.postTarget.create({
          data: {
            postId: created.id,
            socialAccountId: validated.tiktokAccountId,
            platform: "TIKTOK",
            contentType: validated.tiktokContentType,
            publishMode: "TIKTOK_DRAFT",
            status: "PENDING",
          },
        });
      }

      return created;
    });
    postId = post.id;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erreur inconnue";
    return { error: `Échec de la création : ${message}` };
  }

  // Programmation dans sa propre transaction (schedulePost). Le fuseau de base n'a pas d'incidence
  // sur les horaires effectifs (déjà en UTC via targetTimes) — on passe Europe/Paris comme le reste
  // du projet pour l'affichage.
  const scheduleResult = await schedulePost(
    postId,
    item.baseTime,
    "Europe/Paris",
    timesResult.targetTimes
  );
  if (scheduleResult.error) {
    // Nettoie le brouillon orphelin : pas de DRAFT à moitié créé si la programmation a échoué.
    await db.post.delete({ where: { id: postId } }).catch(() => {});
    return { error: scheduleResult.error };
  }

  return { postId };
}

/**
 * Programme plusieurs posts d'un coup.
 *
 * 1. PRÉ-CHECK GLOBAL : compte les cibles TikTok brouillon du lot (N), appelle
 *    `checkTikTokDraftCapacity(scope user, additionalDrafts = N)`. Si `!allowed` → retour immédiat
 *    `{ blocked: true, message }` SANS RIEN créer (décision produit : blocage explicite).
 * 2. `getInstagramQuotaSnapshot` en AVERTISSEMENT non bloquant (remonté dans `igQuotaWarning`).
 * 3. Pour CHAQUE item : sa propre transaction (création) puis `schedulePost`. Un échec isolé
 *    n'affecte pas les autres items.
 *
 * @param userId identifiant de l'utilisateur (scoping systématique — règle d'ingénierie n°10).
 * @param items  liste des posts à créer+programmer.
 */
export async function scheduleManyPosts(
  userId: string,
  items: BulkItem[],
  options: ScheduleManyOptions = {}
): Promise<ScheduleManyResult> {
  if (items.length === 0) {
    return { blocked: false, results: [], scheduled: 0, failed: 0 };
  }

  // 1. Pré-check GLOBAL de capacité TikTok — AVANT toute écriture.
  const tiktokDraftsInBatch = countTikTokDraftsInBatch(items);
  if (tiktokDraftsInBatch > 0) {
    const capacity = await checkTikTokDraftCapacity(
      { userId },
      tiktokDraftsInBatch,
      options.windowHours
    );
    if (!capacity.allowed) {
      return {
        blocked: true,
        message:
          capacity.message ??
          "Plafond de brouillons TikTok atteint pour ce lot — réduisez le nombre de posts TikTok.",
      };
    }
  }

  // 2. Snapshot quota Instagram (avertissement NON bloquant). On le lit une seule fois pour le lot,
  //    sur le compte Instagram de l'utilisateur, uniquement si au moins un item cible Instagram.
  let igQuotaWarning: string | undefined;
  const igTargetsInBatch = items.filter((i) => i.platforms.instagram).length;
  if (igTargetsInBatch > 0) {
    const igAccount = await db.socialAccount.findFirst({
      where: { userId, platform: "INSTAGRAM" },
    });
    if (igAccount) {
      const snapshot = await getInstagramQuotaSnapshot(igAccount.id);
      if (snapshot) {
        const remaining = snapshot.total - snapshot.used;
        if (igTargetsInBatch > remaining) {
          igQuotaWarning =
            `Ce lot contient ${igTargetsInBatch} publication(s) Instagram, mais il ne reste ` +
            `que ${Math.max(0, remaining)} place(s) sur votre quota Instagram (${snapshot.used}/${snapshot.total} utilisées sur 24 h). ` +
            `Certaines publications pourraient être refusées par Instagram — vérifiez après coup.`;
        }
      }
    }
  }

  // 3. Chaque item dans sa propre transaction — un échec isolé n'annule pas les autres.
  const results: BulkItemResult[] = [];
  for (let index = 0; index < items.length; index++) {
    const item = items[index];

    const validation = await validateItem(userId, item);
    if (!validation.ok) {
      results.push({ index, ok: false, error: validation.error });
      continue;
    }

    const outcome = await createAndScheduleItem(userId, item, validation.value);
    if ("error" in outcome) {
      results.push({ index, ok: false, error: outcome.error });
    } else {
      results.push({ index, ok: true, postId: outcome.postId });
    }
  }

  const scheduled = results.filter((r) => r.ok).length;
  const failed = results.length - scheduled;

  return { blocked: false, results, scheduled, failed, igQuotaWarning };
}
