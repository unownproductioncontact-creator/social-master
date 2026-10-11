import "server-only";
import { db } from "@/lib/db";
import { deleteObject } from "@/lib/storage";
import { deleteMediaAssetForUser } from "@/lib/media-delete";
import { objectKeysOfAsset } from "@/lib/media-keys";
import {
  selectPurgeableMedia,
  selectUnusedStaleMedia,
  UNUSED_MEDIA_MAX_AGE_DAYS,
  type RetentionCandidate,
} from "@/lib/media-retention";
import { notifyTelegram } from "@/lib/telegram";

/** Un MediaAsset resté UPLOADING plus longtemps que ça est considéré orphelin (PUT R2 jamais terminé). */
const STALE_UPLOAD_THRESHOLD_MS = 60 * 60 * 1000; // 1 h

/**
 * Filet de sécurité pour les uploads jamais finalisés (échec du PUT R2, onglet fermé en cours
 * d'envoi, etc.) : le MediaAsset reste alors en `status=UPLOADING` pour toujours, invisible dans
 * la médiathèque (qui ne liste que READY, voir src/app/(app)/library/page.tsx) — orphelin en base
 * ET potentiellement sur R2. Exécuté quotidiennement (même pattern que storage-check-job.ts).
 *
 * Best-effort sur la suppression R2 : dans le cas courant, le PUT n'a jamais réussi et l'objet
 * n'existe donc probablement pas — `deleteObject` sur une clé absente ne doit pas empêcher le
 * nettoyage de la ligne en base, seul un vrai objet orphelin doit être supprimé.
 */
export async function runMediaCleanup(): Promise<void> {
  const staleAssets = await db.mediaAsset.findMany({
    where: {
      status: "UPLOADING",
      createdAt: { lt: new Date(Date.now() - STALE_UPLOAD_THRESHOLD_MS) },
    },
    select: { id: true, storageKey: true, thumbnailKey: true },
  });

  let purgedCount = 0;
  for (const asset of staleAssets) {
    for (const key of objectKeysOfAsset(asset)) {
      try {
        await deleteObject(key);
      } catch (err) {
        // Best-effort : l'objet n'existe probablement pas (PUT jamais terminé). On journalise pour
        // garder une trace en cas de vrai problème R2, mais on continue le nettoyage DB dans tous les cas.
        console.warn(`[media-cleanup] suppression R2 échouée pour ${key} (ignorée)`, err);
      }
    }

    await db.mediaAsset.delete({ where: { id: asset.id } }).catch((err) => {
      // La ligne a pu être supprimée entre-temps par ailleurs (suppression manuelle concurrente) —
      // ne pas faire échouer tout le job pour un seul enregistrement disparu.
      console.warn(`[media-cleanup] suppression DB échouée pour ${asset.id} (ignorée)`, err);
    });
    purgedCount++;
  }

  console.log(`[media-cleanup] ${purgedCount} média(s) UPLOADING orphelin(s) purgé(s)`);

  // Deuxième passe : rétention automatique optionnelle des médias déjà publiés (voir CLAUDE.md §15bis).
  await runRetentionPurge();

  // Troisième passe : médias jamais utilisés dans un post depuis plus de 30 jours (CLAUDE.md §36).
  await runUnusedMediaPurge();
}

/**
 * Supprime les médias que AUCUN post n'utilise et qui ont été ajoutés il y a plus de
 * `UNUSED_MEDIA_MAX_AGE_DAYS` jours (essais, doublons, envois oubliés — demande du user, 11/10/2026).
 * Un brouillon suffit à protéger un média. Comme `runRetentionPurge`, sans lien avec le réglage de
 * rétention du user. Requêtes séquentielles (cf. §15/§18) ; un échec n'interrompt pas la boucle.
 */
async function runUnusedMediaPurge(): Promise<void> {
  const now = new Date();
  const cutoff = new Date(now.getTime() - UNUSED_MEDIA_MAX_AGE_DAYS * 24 * 60 * 60 * 1000);

  const assets = await db.mediaAsset.findMany({
    where: { status: "READY", createdAt: { lt: cutoff }, postMedia: { none: {} } },
    select: { id: true, userId: true, sizeBytes: true, createdAt: true, _count: { select: { postMedia: true } } },
  });
  const purgeable = new Set(
    selectUnusedStaleMedia(
      assets.map((a) => ({ id: a.id, createdAt: a.createdAt, postCount: a._count.postMedia })),
      now
    )
  );

  let deleted = 0;
  let bytes = 0;
  for (const asset of assets) {
    if (!purgeable.has(asset.id)) continue;
    try {
      // Re-vérification juste avant : un brouillon a pu s'en emparer depuis la requête ci-dessus, et
      // `deleteMediaAssetForUser` supprimerait ce brouillon avec le média.
      const fresh = await db.mediaAsset.findUnique({
        where: { id: asset.id },
        select: { _count: { select: { postMedia: true } } },
      });
      if (!fresh || fresh._count.postMedia > 0) continue;

      const result = await deleteMediaAssetForUser(asset.userId, asset.id);
      if (result.error) {
        console.warn(`[media-cleanup] médias inutilisés : suppression de ${asset.id} refusée : ${result.error}`);
        continue;
      }
      deleted++;
      bytes += asset.sizeBytes;
    } catch (err) {
      console.error(`[media-cleanup] médias inutilisés : exception sur ${asset.id}`, err);
    }
  }

  console.log(`[media-cleanup] médias jamais utilisés : ${deleted} supprimé(s)`);
  if (deleted > 0) {
    await notifyTelegram(
      `🧹 ${deleted} média${deleted > 1 ? "s" : ""} jamais utilisé${deleted > 1 ? "s" : ""} depuis plus de ` +
        `${UNUSED_MEDIA_MAX_AGE_DAYS} jours supprimé${deleted > 1 ? "s" : ""} de la médiathèque ` +
        `(${(bytes / (1024 * 1024)).toFixed(1)} Mo libérés).`
    );
  }
}

/**
 * Purge de rétention : pour chaque utilisateur ayant configuré `mediaRetentionDays`, supprime les
 * médias dont TOUTES les publications sont parties depuis plus longtemps que la rétention choisie
 * (voir `selectPurgeableMedia`). Le fichier est retiré du stockage (`deleteMediaAssetForUser` détache
 * le média des posts publiés — l'historique est préservé). Best-effort par média (une erreur
 * n'interrompt pas la boucle) ; requêtes SÉQUENTIELLES volontairement (le moteur `prisma dev` casse
 * sous concurrence, cf. CLAUDE.md §15/§18 — le coût est négligeable en prod).
 */
async function runRetentionPurge(): Promise<void> {
  const users = await db.user.findMany({
    where: { mediaRetentionDays: { not: null } },
    select: { id: true, mediaRetentionDays: true },
  });

  const now = new Date();
  let totalPurged = 0;

  for (const user of users) {
    const retentionDays = user.mediaRetentionDays;
    if (retentionDays == null) continue; // le filtre SQL l'exclut déjà ; garde de typage

    const assets = await db.mediaAsset.findMany({
      where: { userId: user.id, status: "READY" },
      select: {
        id: true,
        postMedia: {
          select: {
            post: {
              select: {
                status: true,
                updatedAt: true,
                postTargets: { select: { publishedAt: true } },
              },
            },
          },
        },
      },
    });

    const candidates: RetentionCandidate[] = assets.map((asset) => {
      const posts = asset.postMedia.map((pm) => pm.post);
      const used = posts.length > 0;
      const allPublished = used && posts.every((p) => p.status === "PUBLISHED");
      const inUseByPendingPost = posts.some((p) => p.status !== "PUBLISHED");

      // Dernière publication : le plus récent `PostTarget.publishedAt` de tous les posts du média
      // (repli sur `Post.updatedAt` d'un post publié dont les cibles n'auraient pas de date).
      let lastPublishedAt: Date | null = null;
      if (allPublished) {
        let maxMs = 0;
        for (const p of posts) {
          const targetTimes = p.postTargets
            .map((t) => t.publishedAt?.getTime())
            .filter((ms): ms is number => ms != null);
          const postMs = targetTimes.length > 0 ? Math.max(...targetTimes) : p.updatedAt.getTime();
          if (postMs > maxMs) maxMs = postMs;
        }
        lastPublishedAt = maxMs > 0 ? new Date(maxMs) : null;
      }

      return { id: asset.id, allPostsResolved: allPublished, lastPublishedAt, inUseByPendingPost };
    });

    const purgeableIds = selectPurgeableMedia(candidates, retentionDays, now);

    let userPurged = 0;
    for (const id of purgeableIds) {
      try {
        const result = await deleteMediaAssetForUser(user.id, id);
        if (result.error) {
          console.warn(
            `[media-cleanup] rétention : suppression du média ${id} (user ${user.id}) refusée : ${result.error}`
          );
          continue;
        }
        userPurged++;
      } catch (err) {
        // Best-effort : une exception sur un média ne stoppe pas la boucle.
        console.error(
          `[media-cleanup] rétention : exception sur le média ${id} (user ${user.id})`,
          err
        );
      }
    }

    if (userPurged > 0) {
      console.log(
        `[media-cleanup] rétention : ${userPurged} média(s) publié(s) purgé(s) pour le user ${user.id} (rétention ${retentionDays} j)`
      );
    }
    totalPurged += userPurged;
  }

  console.log(`[media-cleanup] rétention : ${totalPurged} média(s) publié(s) purgé(s) au total`);
}
