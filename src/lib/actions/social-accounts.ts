"use server";

import { revalidatePath } from "next/cache";
import { verifySession } from "@/lib/dal";
import { db } from "@/lib/db";
import { checkSocialAccountHealth } from "@/lib/social-account-health";
import { cleanAccountLabel } from "@/lib/social-accounts";

export async function verifySocialAccount(accountId: string): Promise<void> {
  const session = await verifySession();

  const account = await db.socialAccount.findUnique({ where: { id: accountId } });
  if (!account || account.userId !== session.userId) return;

  await checkSocialAccountHealth(accountId);
  revalidatePath("/connections");
}

/**
 * Déconnecte (supprime en cascade) un compte social. Renvoie `{ error?: string }` — contrat attendu
 * par `ConfirmDeleteButton.onConfirm` (voir confirm-delete-button.tsx) quand l'action est liée via
 * `.bind(null, accountId)`. Comportement métier inchangé : suppression + revalidation de /connections.
 */
export async function disconnectSocialAccount(accountId: string): Promise<{ error?: string }> {
  const session = await verifySession();

  const account = await db.socialAccount.findUnique({ where: { id: accountId } });
  if (!account || account.userId !== session.userId) {
    return { error: "Compte introuvable." };
  }

  await db.socialAccount.delete({ where: { id: accountId } });

  await db.activityLog.create({
    data: {
      userId: session.userId,
      entityType: "SocialAccount",
      entityId: accountId,
      action: `${account.platform.toLowerCase()}_disconnected`,
      detail: { username: account.username },
    },
  });

  revalidatePath("/connections");
  return {};
}

/**
 * Donne un nom à un compte (« Principal », « Clips »…) quand plusieurs comptes d'un même réseau sont
 * connectés (CLAUDE.md §44). Vide = retirer le nom (on affiche alors @pseudo). Utilisée par un formulaire.
 */
export async function renameSocialAccount(accountId: string, formData: FormData): Promise<void> {
  const session = await verifySession();
  const account = await db.socialAccount.findUnique({ where: { id: accountId } });
  if (!account || account.userId !== session.userId) return;
  await db.socialAccount.update({
    where: { id: accountId },
    data: { label: cleanAccountLabel(String(formData.get("label") ?? "")) },
  });
  revalidatePath("/connections");
  revalidatePath("/composer");
}
