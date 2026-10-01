import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({ db: { socialAccount: { update: vi.fn(async () => ({})) } } }));
vi.mock("@/lib/crypto", () => ({
  decryptToken: (v: string) => v.replace(/^enc:/, ""),
  encryptToken: (v: string) => `enc:${v}`,
}));
vi.mock("@/lib/providers/tiktok", () => ({ refreshTikTokToken: vi.fn() }));

import { db } from "@/lib/db";
import { refreshTikTokToken } from "@/lib/providers/tiktok";
import { freshTikTokAccessToken } from "@/lib/tiktok-token";

const HOUR = 3600 * 1000;
const account = (expiresInMs: number | null) => ({
  id: "acc_tt",
  accessTokenEnc: "enc:ancien_access",
  refreshTokenEnc: "enc:ancien_refresh",
  tokenExpiresAt: expiresInMs === null ? null : new Date(Date.now() + expiresInMs),
});

describe("freshTikTokAccessToken", () => {
  beforeEach(() => {
    vi.mocked(refreshTikTokToken).mockReset();
    vi.mocked(db.socialAccount.update).mockClear();
  });

  it("jeton encore valide largement : utilisé tel quel, aucun appel à TikTok", async () => {
    await expect(freshTikTokAccessToken(account(3 * HOUR))).resolves.toBe("ancien_access");
    expect(refreshTikTokToken).not.toHaveBeenCalled();
  });

  // Incident du 01/10/2026 : jeton de 24 h expiré l'après-midi, le cron de 4h UTC tombant pendant la veille.
  it("jeton expiré (ou presque) : rafraîchi avant usage, nouveaux jetons stockés (rotation)", async () => {
    vi.mocked(refreshTikTokToken).mockResolvedValue({
      access_token: "nouvel_access",
      refresh_token: "nouveau_refresh",
      expires_in: 86400,
      refresh_expires_in: 31536000,
    } as never);

    await expect(freshTikTokAccessToken(account(-2 * HOUR))).resolves.toBe("nouvel_access");

    expect(refreshTikTokToken).toHaveBeenCalledWith("ancien_refresh");
    const { data } = vi.mocked(db.socialAccount.update).mock.calls[0][0] as { data: Record<string, unknown> };
    expect(data.accessTokenEnc).toBe("enc:nouvel_access");
    expect(data.refreshTokenEnc).toBe("enc:nouveau_refresh");
    expect((data.tokenExpiresAt as Date).getTime()).toBeGreaterThan(Date.now() + 23 * HOUR);
  });

  it("TikTok répond sans jeton (invalid_grant) : erreur explicite, rien d'écrit en base", async () => {
    vi.mocked(refreshTikTokToken).mockResolvedValue({ error: "invalid_grant", error_description: "Refresh token is invalid" } as never);

    await expect(freshTikTokAccessToken(account(5 * 60 * 1000))).rejects.toThrow("invalid_grant");
    expect(db.socialAccount.update).not.toHaveBeenCalled();
  });

  it("le cron peut exiger une marge plus large (6 h)", async () => {
    vi.mocked(refreshTikTokToken).mockResolvedValue({
      access_token: "a",
      refresh_token: "r",
      expires_in: 86400,
      refresh_expires_in: 31536000,
    } as never);
    await freshTikTokAccessToken(account(3 * HOUR), 6 * HOUR);
    expect(refreshTikTokToken).toHaveBeenCalledTimes(1);
  });
});
