import "server-only";
import { db } from "@/lib/db";
import { decryptToken, encryptToken } from "@/lib/crypto";
import { refreshYouTubeAccessToken } from "@/lib/providers/youtube";

/** Marge par défaut : un envoi de miniature ou une lecture dure quelques secondes. */
const DEFAULT_MIN_VALIDITY_MS = 5 * 60 * 1000;

export type YouTubeAccountTokens = {
  id: string;
  accessTokenEnc: string;
  refreshTokenEnc: string | null;
  tokenExpiresAt: Date | null;
};

/**
 * Jeton d'accès YouTube utilisable tout de suite (CLAUDE.md §37). Il ne vit qu'~1 h et le cron ne
 * touche pas aux comptes YouTube (§25) : on rafraîchit juste avant usage s'il expire dans moins de
 * `minValidityMs`. Google ne fait pas tourner le refresh token, mais s'il en renvoie un on le stocke.
 * Même principe que `freshTikTokAccessToken` (§32). La publication d'une vidéo, elle, rafraîchit
 * toujours (publish-job) : la miniature posée juste après réutilise donc ce jeton neuf.
 */
export async function freshYouTubeAccessToken(
  account: YouTubeAccountTokens,
  minValidityMs = DEFAULT_MIN_VALIDITY_MS
): Promise<string> {
  const expiresAt = account.tokenExpiresAt?.getTime();
  if (expiresAt !== undefined && expiresAt - Date.now() > minValidityMs) {
    return decryptToken(account.accessTokenEnc);
  }
  if (!account.refreshTokenEnc) {
    throw new Error("invalid_grant: aucun jeton de rafraîchissement YouTube stocké (reconnexion requise).");
  }

  const refreshed = await refreshYouTubeAccessToken(decryptToken(account.refreshTokenEnc));
  if (!refreshed.access_token) {
    throw new Error("Refresh token YouTube : réponse sans jeton d'accès.");
  }
  await db.socialAccount.update({
    where: { id: account.id },
    data: {
      accessTokenEnc: encryptToken(refreshed.access_token),
      ...(refreshed.refresh_token ? { refreshTokenEnc: encryptToken(refreshed.refresh_token) } : {}),
      tokenExpiresAt: new Date(Date.now() + refreshed.expires_in * 1000),
      lastCheckedAt: new Date(),
    },
  });
  return refreshed.access_token;
}
