import "server-only";
import { db } from "@/lib/db";
import { decryptToken } from "@/lib/crypto";
import { fetchInstagramProfile } from "@/lib/providers/instagram";
import { fetchTikTokUserInfo } from "@/lib/providers/tiktok";

/**
 * Vérifie qu'un compte social est toujours joignable avec le token stocké.
 * Réutilisé par l'action manuelle "Vérifier" et par le cron de refresh (étape 10).
 */
export async function checkSocialAccountHealth(accountId: string): Promise<void> {
  const account = await db.socialAccount.findUnique({ where: { id: accountId } });
  if (!account) return;

  try {
    const accessToken = decryptToken(account.accessTokenEnc);

    if (account.platform === "INSTAGRAM") {
      await fetchInstagramProfile(accessToken);
    } else {
      await fetchTikTokUserInfo(accessToken);
    }

    await db.socialAccount.update({
      where: { id: accountId },
      data: { status: "ACTIVE", lastCheckedAt: new Date() },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erreur inconnue";
    await db.socialAccount.update({
      where: { id: accountId },
      data: { status: "NEEDS_REAUTH", lastCheckedAt: new Date() },
    });
    await db.activityLog.create({
      data: {
        userId: account.userId,
        entityType: "SocialAccount",
        entityId: accountId,
        action: `${account.platform.toLowerCase()}_health_check_failed`,
        detail: { message },
      },
    });
  }
}
