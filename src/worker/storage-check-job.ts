import "server-only";
import { db } from "@/lib/db";
import { notifyTelegram } from "@/lib/telegram";

/** Palier gratuit Cloudflare R2 (stockage à l'instant T, pas un quota mensuel). */
export const R2_FREE_TIER_BYTES = 10 * 1024 ** 3;
const ALERT_THRESHOLD_RATIO = 0.8;

function formatGb(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(1);
}

/** Pure : décide s'il faut alerter et compose le message. Pas d'I/O — testable sans DB. */
export function evaluateStorageAlert(usedBytes: number): { shouldAlert: boolean; message?: string } {
  if (usedBytes < R2_FREE_TIER_BYTES * ALERT_THRESHOLD_RATIO) return { shouldAlert: false };

  const percent = Math.round((usedBytes / R2_FREE_TIER_BYTES) * 100);
  return {
    shouldAlert: true,
    message:
      `📦 Stockage R2 à ${percent} % du palier gratuit (${formatGb(usedBytes)} Go / 10 Go).\n` +
      `Supprimez d'anciens médias déjà publiés dans la médiathèque, ou laissez filer — le dépassement coûte environ 0,015 $/Go/mois.`,
  };
}

/**
 * Filet de sécurité pour le stockage R2 (aucune suppression automatique après publication —
 * voir CLAUDE.md). Somme les médias `READY` en base (déjà connue, pas d'appel R2/ListObjects
 * nécessaire) plutôt que d'interroger R2 directement. Exécuté 1×/jour (comme le refresh de
 * tokens) : la variation de ce chiffre est lente, un contrôle quotidien est largement suffisant.
 */
export async function runStorageCheck(): Promise<void> {
  const { _sum } = await db.mediaAsset.aggregate({
    where: { status: "READY" },
    _sum: { sizeBytes: true },
  });

  const { shouldAlert, message } = evaluateStorageAlert(_sum.sizeBytes ?? 0);
  if (shouldAlert && message) await notifyTelegram(message);
}
