import "server-only";
import { db } from "@/lib/db";

/** Statut agrégé résolu retourné par `recomputePostStatus` ; `null` = post encore en cours (inchangé). */
export type ResolvedPostStatus = "PUBLISHED" | "PARTIALLY_PUBLISHED" | "FAILED";

/**
 * Recalcule le statut agrégé d'un post à partir de ses PostTarget. À appeler après toute résolution
 * (succès/échec terminal) d'une target. Retourne le statut résolu écrit en base, ou `null` si le post
 * reste en cours (targets encore en attente) — l'appelant s'en sert p. ex. pour déclencher la purge
 * immédiate des médias quand le post devient `PUBLISHED` (voir purgeMediaForPublishedPost).
 */
export async function recomputePostStatus(postId: string): Promise<ResolvedPostStatus | null> {
  const targets = await db.postTarget.findMany({ where: { postId } });
  if (targets.length === 0) return null;

  const resolved = (s: string) => s === "PUBLISHED" || s === "SENT_TO_INBOX" || s === "FAILED";
  const succeeded = (s: string) => s === "PUBLISHED" || s === "SENT_TO_INBOX";

  if (!targets.every((t) => resolved(t.status))) {
    return null; // encore des targets en attente/en cours : le post reste SCHEDULED
  }

  const anySucceeded = targets.some((t) => succeeded(t.status));
  const anyFailed = targets.some((t) => t.status === "FAILED");

  const status: ResolvedPostStatus = anyFailed
    ? anySucceeded
      ? "PARTIALLY_PUBLISHED"
      : "FAILED"
    : "PUBLISHED";

  await db.post.update({ where: { id: postId }, data: { status } });
  return status;
}
