import "server-only";
import { db } from "@/lib/db";
import { decryptToken, encryptToken } from "@/lib/crypto";
import { fetchInstagramProfile } from "@/lib/providers/instagram";
import { fetchTikTokUserInfo } from "@/lib/providers/tiktok";
import { fetchYouTubeChannel, refreshYouTubeAccessToken } from "@/lib/providers/youtube";

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
    } else if (account.platform === "YOUTUBE") {
      // L'access token Google (~1h) est presque toujours périmé au moment du check : on rafraîchit
      // d'abord (et on persiste le token frais), puis on lit la chaîne — sinon 401 systématique.
      if (!account.refreshTokenEnc) {
        throw new Error("refresh token YouTube absent — reconnexion requise");
      }
      const refreshed = await refreshYouTubeAccessToken(decryptToken(account.refreshTokenEnc));
      await db.socialAccount.update({
        where: { id: accountId },
        data: {
          accessTokenEnc: encryptToken(refreshed.access_token),
          // Google ne fait normalement PAS tourner le refresh token ; on restocke par prudence s'il revient.
          ...(refreshed.refresh_token ? { refreshTokenEnc: encryptToken(refreshed.refresh_token) } : {}),
          tokenExpiresAt: new Date(Date.now() + refreshed.expires_in * 1000),
        },
      });
      await fetchYouTubeChannel(refreshed.access_token);
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
