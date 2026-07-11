import "server-only";
import { db } from "@/lib/db";
import { decryptToken, encryptToken } from "@/lib/crypto";
import { refreshLongLivedToken } from "@/lib/providers/instagram";
import { refreshTikTokToken } from "@/lib/providers/tiktok";
import { notifyTelegram } from "@/lib/telegram";

const IG_REFRESH_THRESHOLD_DAYS = 10; // token longue durée = 60 j, on rafraîchit largement en avance
const TIKTOK_REFRESH_THRESHOLD_HOURS = 6; // access token = 24h, on rafraîchit plusieurs fois par jour

/** Exécuté quotidiennement (boss.schedule) : rafraîchit les tokens qui approchent de l'expiration. */
export async function runTokenRefresh(): Promise<void> {
  const accounts = await db.socialAccount.findMany({ where: { status: "ACTIVE" } });

  for (const account of accounts) {
    try {
      if (account.platform === "INSTAGRAM") {
        await maybeRefreshInstagram(account);
      } else if (account.platform === "YOUTUBE") {
        // V1 (CLAUDE.md §25) : NO-OP explicite pour YouTube. L'access token Google (~1h) est rafraîchi
        // JUSTE avant chaque publication (worker/publish-job.ts), et Google ne fait pas tourner le
        // refresh token → rien à anticiper ici. Surtout NE PAS router un compte YouTube vers
        // maybeRefreshTikTok (il enverrait le refresh token Google à l'endpoint TikTok → échec →
        // NEEDS_REAUTH à tort). Branche laissée vide à dessein pour ne pas casser la boucle existante.
      } else {
        await maybeRefreshTikTok(account);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Erreur inconnue";
      await db.socialAccount.update({ where: { id: account.id }, data: { status: "NEEDS_REAUTH" } });
      await db.activityLog.create({
        data: {
          userId: account.userId,
          entityType: "SocialAccount",
          entityId: account.id,
          action: `${account.platform.toLowerCase()}_refresh_failed`,
          detail: { message },
        },
      });
      await notifyTelegram(`⚠️ Refresh du token ${account.platform} échoué pour @${account.username} — reconnexion requise.`);
    }
  }
}

async function maybeRefreshInstagram(account: { id: string; accessTokenEnc: string; tokenExpiresAt: Date | null }) {
  if (!account.tokenExpiresAt) return;
  const daysLeft = (account.tokenExpiresAt.getTime() - Date.now()) / (24 * 3600 * 1000);
  if (daysLeft > IG_REFRESH_THRESHOLD_DAYS) return;

  const accessToken = decryptToken(account.accessTokenEnc);
  const refreshed = await refreshLongLivedToken(accessToken);

  await db.socialAccount.update({
    where: { id: account.id },
    data: {
      accessTokenEnc: encryptToken(refreshed.access_token),
      tokenExpiresAt: new Date(Date.now() + refreshed.expires_in * 1000),
      lastCheckedAt: new Date(),
    },
  });
}

async function maybeRefreshTikTok(account: {
  id: string;
  refreshTokenEnc: string | null;
  tokenExpiresAt: Date | null;
}) {
  if (!account.refreshTokenEnc || !account.tokenExpiresAt) return;
  const hoursLeft = (account.tokenExpiresAt.getTime() - Date.now()) / (3600 * 1000);
  if (hoursLeft > TIKTOK_REFRESH_THRESHOLD_HOURS) return;

  const refreshToken = decryptToken(account.refreshTokenEnc);
  const refreshed = await refreshTikTokToken(refreshToken);
  const now = Date.now();

  await db.socialAccount.update({
    where: { id: account.id },
    data: {
      accessTokenEnc: encryptToken(refreshed.access_token),
      // Le refresh_token peut avoir changé (rotation) — toujours restocker la valeur retournée.
      refreshTokenEnc: encryptToken(refreshed.refresh_token),
      tokenExpiresAt: new Date(now + refreshed.expires_in * 1000),
      refreshExpiresAt: new Date(now + refreshed.refresh_expires_in * 1000),
      lastCheckedAt: new Date(),
    },
  });
}
