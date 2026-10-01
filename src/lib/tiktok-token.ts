import "server-only";
import { db } from "@/lib/db";
import { decryptToken, encryptToken } from "@/lib/crypto";
import { refreshTikTokToken } from "@/lib/providers/tiktok";

/** Marge par défaut : couvre un envoi complet (upload + jusqu'à 5 min d'attente de livraison). */
const DEFAULT_MIN_VALIDITY_MS = 15 * 60 * 1000;

export type TikTokAccountTokens = {
  id: string;
  accessTokenEnc: string;
  refreshTokenEnc: string | null;
  tokenExpiresAt: Date | null;
};

/**
 * Jeton d'accès TikTok utilisable tout de suite. Il ne vit que 24 h et le cron de rafraîchissement
 * (4h UTC) tombe pendant la veille nocturne du service (CLAUDE.md §21) : sans ceci, un envoi l'après-midi
 * partait avec un jeton expiré (constaté le 01/10/2026). On rafraîchit donc juste avant usage quand il
 * expire dans moins de `minValidityMs`, en stockant le refresh_token renvoyé (rotation TikTok).
 */
export async function freshTikTokAccessToken(
  account: TikTokAccountTokens,
  minValidityMs = DEFAULT_MIN_VALIDITY_MS
): Promise<string> {
  const expiresAt = account.tokenExpiresAt?.getTime();
  if (!account.refreshTokenEnc || expiresAt === undefined || expiresAt - Date.now() > minValidityMs) {
    return decryptToken(account.accessTokenEnc);
  }

  const refreshed = await refreshTikTokToken(decryptToken(account.refreshTokenEnc));
  if (!refreshed.access_token || !refreshed.refresh_token) {
    // TikTok peut répondre 200 avec { error: "invalid_grant", … } : jamais stocker un jeton vide.
    const { error, error_description } = refreshed as { error?: string; error_description?: string };
    throw new Error(`Refresh token TikTok refusé : ${error ?? "réponse sans jeton"} — ${error_description ?? ""}`);
  }
  const now = Date.now();
  await db.socialAccount.update({
    where: { id: account.id },
    data: {
      accessTokenEnc: encryptToken(refreshed.access_token),
      refreshTokenEnc: encryptToken(refreshed.refresh_token),
      tokenExpiresAt: new Date(now + refreshed.expires_in * 1000),
      refreshExpiresAt: new Date(now + refreshed.refresh_expires_in * 1000),
      lastCheckedAt: new Date(),
    },
  });
  return refreshed.access_token;
}
