import "server-only";
import { db } from "@/lib/db";
import { deleteObject } from "@/lib/storage";

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
}
