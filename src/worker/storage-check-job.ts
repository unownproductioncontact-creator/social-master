import "server-only";
import { db } from "@/lib/db";
import { mediaWorkerPushConfig } from "@/lib/storage";
import { listBucket } from "@/lib/media-worker";
import { notifyTelegram } from "@/lib/telegram";

/** Palier gratuit Cloudflare R2 (stockage à l'instant T, pas un quota mensuel). */
export const R2_FREE_TIER_BYTES = 10 * 1024 ** 3;
// Seuil choisi par le user le 11/10/2026 (alerte Telegram quotidienne au-delà).
const ALERT_THRESHOLD_RATIO = 0.7;

function formatGb(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(1);
}

/** Détail d'une mesure faite par le Worker, ajouté au message d'alerte. */
export type MeasuredUsage = { objects: number; knownMediaBytes: number };

/** Pure : décide s'il faut alerter et compose le message. Pas d'I/O — testable sans DB. */
export function evaluateStorageAlert(
  usedBytes: number,
  measured?: MeasuredUsage
): { shouldAlert: boolean; message?: string } {
  if (usedBytes < R2_FREE_TIER_BYTES * ALERT_THRESHOLD_RATIO) return { shouldAlert: false };

  const percent = Math.round((usedBytes / R2_FREE_TIER_BYTES) * 100);
  const detail = measured
    ? `\nMesuré dans le bucket : ${measured.objects} objet${measured.objects > 1 ? "s" : ""}, dont ${formatGb(measured.knownMediaBytes)} Go de médias connus de la médiathèque (le reste : miniatures, copies JPEG, orphelins).`
    : "";
  return {
    shouldAlert: true,
    message:
      `📦 Stockage R2 à ${percent} % du palier gratuit (${formatGb(usedBytes)} Go / 10 Go).${detail}\n` +
      `Supprimez d'anciens médias déjà publiés dans la médiathèque, ou laissez filer — le dépassement coûte environ 0,015 $/Go/mois.`,
  };
}

/**
 * Filet de sécurité pour le stockage R2 (la purge après publication est optionnelle — voir CLAUDE.md
 * §26 et §36). Exécuté 1×/jour (comme le refresh de tokens) : la variation de ce chiffre est lente.
 *
 * Mesure RÉELLE du bucket par le Worker Cloudflare (`GET /usage` : tous les objets — originaux,
 * miniatures, copies JPEG, orphelins). La somme des médias READY en base ne comptait ni les
 * miniatures, ni les copies, ni les orphelins : elle sert de repli quand le Worker est absent ou en
 * panne, et le dit (une mesure qui se dégrade en silence est pire que pas de mesure).
 */
export async function runStorageCheck(): Promise<void> {
  const { _sum } = await db.mediaAsset.aggregate({
    where: { status: "READY" },
    _sum: { sizeBytes: true },
  });
  const knownMediaBytes = _sum.sizeBytes ?? 0;

  let usedBytes = knownMediaBytes;
  let measured: MeasuredUsage | undefined;

  const worker = mediaWorkerPushConfig();
  if (worker) {
    try {
      const listing = await listBucket(worker);
      usedBytes = listing.bytes;
      measured = { objects: listing.objects, knownMediaBytes };
      console.log(
        `[storage-check] bucket R2 : ${listing.objects} objet(s), ${formatGb(listing.bytes)} Go mesurés ` +
          `(médias connus en base : ${formatGb(knownMediaBytes)} Go)`
      );
    } catch (err) {
      console.error("[storage-check] mesure par le Worker impossible, repli sur la base", err);
      await notifyTelegram(
        `⚠️ Mesure du stockage R2 impossible (Worker Cloudflare injoignable ou mal configuré) : ` +
          `repli sur la somme des médias en base (${formatGb(knownMediaBytes)} Go), qui sous-estime l'usage réel.`
      );
    }
  } else {
    console.log(`[storage-check] Worker non configuré : médias en base ${formatGb(knownMediaBytes)} Go (sous-estime l'usage réel)`);
  }

  const { shouldAlert, message } = evaluateStorageAlert(usedBytes, measured);
  if (shouldAlert && message) await notifyTelegram(message);
}
