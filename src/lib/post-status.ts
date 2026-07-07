import "server-only";
import { db } from "@/lib/db";

/** Recalcule le statut agrégé d'un post à partir de ses PostTarget. À appeler après toute résolution (succès/échec terminal) d'une target. */
export async function recomputePostStatus(postId: string): Promise<void> {
  const targets = await db.postTarget.findMany({ where: { postId } });
  if (targets.length === 0) return;

  const resolved = (s: string) => s === "PUBLISHED" || s === "SENT_TO_INBOX" || s === "FAILED";
  const succeeded = (s: string) => s === "PUBLISHED" || s === "SENT_TO_INBOX";

  if (!targets.every((t) => resolved(t.status))) {
    return; // encore des targets en attente/en cours : le post reste SCHEDULED
  }

  const anySucceeded = targets.some((t) => succeeded(t.status));
  const anyFailed = targets.some((t) => t.status === "FAILED");

  const status = anyFailed ? (anySucceeded ? "PARTIALLY_PUBLISHED" : "FAILED") : "PUBLISHED";

  await db.post.update({ where: { id: postId }, data: { status } });
}
