import "server-only";
import { db } from "@/lib/db";
import { deleteObject, mediaWorkerPushConfig } from "@/lib/storage";
import { listBucket } from "@/lib/media-worker";
import { referencedObjectKeys } from "@/lib/media-keys";
import { orphanCountLooksSafe, selectOrphanObjects, SWEPT_PREFIX } from "@/lib/orphan-sweep";
import { notifyTelegram } from "@/lib/telegram";

export type OrphanSweepReport =
  | { status: "skipped"; reason: string }
  | { status: "aborted"; reason: string; eligible: number; inspected: number }
  | { status: "done"; deleted: number; failed: number; bytes: number; inspected: number; tooRecent: number };

function mo(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

/**
 * Balayage mensuel R2 ↔ base (CLAUDE.md §36, point 5) : supprime les objets de `media/` que plus aucun
 * média de la base ne référence (original, miniature, copie JPEG), à condition qu'ils aient plus de
 * 7 jours. Le contenu RÉEL du bucket vient du Worker (`/usage`) ; sans Worker, rien n'est supprimé.
 *
 * Garde-fous : base vide face à un bucket plein, ou plus de la moitié du bucket « orphelin » (au-delà
 * d'une dizaine) → on s'arrête et on prévient, on ne supprime pas. Une alerte Telegram résume chaque
 * passage qui supprime quelque chose.
 */
export async function runOrphanSweep(now: Date = new Date()): Promise<OrphanSweepReport> {
  const worker = mediaWorkerPushConfig();
  if (!worker) {
    console.log("[orphan-sweep] Worker Cloudflare non configuré : balayage ignoré");
    return { status: "skipped", reason: "Worker Cloudflare non configuré" };
  }

  const listing = await listBucket(worker, { prefix: SWEPT_PREFIX, keys: true });
  const assets = await db.mediaAsset.findMany({ select: { storageKey: true, thumbnailKey: true } });

  if (assets.length === 0 && listing.keys.length > 0) {
    const reason = `base sans aucun média alors que le bucket contient ${listing.keys.length} objet(s)`;
    console.error(`[orphan-sweep] interrompu : ${reason}`);
    await notifyTelegram(`⚠️ Balayage du stockage R2 interrompu : ${reason}. Rien n'a été supprimé — vérifier la base de données.`);
    return { status: "aborted", reason, eligible: listing.keys.length, inspected: listing.keys.length };
  }

  const selection = selectOrphanObjects(listing.keys, referencedObjectKeys(assets), now);

  if (!orphanCountLooksSafe(selection.eligible, selection.inspected)) {
    const reason = `${selection.eligible} orphelin(s) sur ${selection.inspected} objet(s) : proportion anormale`;
    console.error(`[orphan-sweep] interrompu : ${reason}`);
    await notifyTelegram(`⚠️ Balayage du stockage R2 interrompu : ${reason}. Rien n'a été supprimé — à vérifier avant de relancer.`);
    return { status: "aborted", reason, eligible: selection.eligible, inspected: selection.inspected };
  }

  let deleted = 0;
  let failed = 0;
  let bytes = 0;
  for (const object of selection.orphans) {
    try {
      await deleteObject(object.key);
      deleted++;
      bytes += object.size;
    } catch (err) {
      failed++;
      console.error(`[orphan-sweep] suppression de ${object.key} échouée`, err);
    }
  }

  console.log(
    `[orphan-sweep] ${selection.inspected} objet(s) inspecté(s), ${deleted} orphelin(s) supprimé(s) (${mo(bytes)} Mo), ` +
      `${failed} échec(s), ${selection.tooRecent} trop récent(s)`
  );
  if (deleted > 0) {
    await notifyTelegram(
      `🧹 Balayage mensuel du stockage R2 : ${deleted} objet${deleted > 1 ? "s" : ""} orphelin${deleted > 1 ? "s" : ""} ` +
        `supprimé${deleted > 1 ? "s" : ""} (${mo(bytes)} Mo).`
    );
  }
  return { status: "done", deleted, failed, bytes, inspected: selection.inspected, tooRecent: selection.tooRecent };
}
