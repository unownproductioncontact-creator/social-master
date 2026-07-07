"use server";

import { revalidatePath } from "next/cache";
import { verifySession } from "@/lib/dal";
import { db } from "@/lib/db";
import { checkSocialAccountHealth } from "@/lib/social-account-health";

export async function verifySocialAccount(accountId: string): Promise<void> {
  const session = await verifySession();

  const account = await db.socialAccount.findUnique({ where: { id: accountId } });
  if (!account || account.userId !== session.userId) return;

  await checkSocialAccountHealth(accountId);
  revalidatePath("/connections");
}

export async function disconnectSocialAccount(accountId: string): Promise<void> {
  const session = await verifySession();

  const account = await db.socialAccount.findUnique({ where: { id: accountId } });
  if (!account || account.userId !== session.userId) {
    return;
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
}
