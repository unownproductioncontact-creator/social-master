import "server-only";
import { db } from "@/lib/db";
import { deleteObject } from "@/lib/storage";
import { deleteMediaAssetForUser } from "@/lib/media-delete";
import { selectPurgeableMedia, type RetentionCandidate } from "@/lib/media-retention";

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
    select: { id: true, storageKey: true },
  });

  let purgedCount = 0;
  for (const asset of staleAssets) {
    try {
      await deleteObject(asset.storageKey);
    } catch (err) {
      // Best-effort : l'objet n'existe probablement pas (PUT jamais terminé). On journalise pour
      // garder une trace en cas de vrai problème R2, mais on continue le nettoyage DB dans tous les cas.
      console.warn(`[media-cleanup] suppression R2 échouée pour ${asset.storageKey} (ignorée)`, err);
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
