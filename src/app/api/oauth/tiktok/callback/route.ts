import { NextRequest, NextResponse } from "next/server";
import { verifySession } from "@/lib/dal";
import { consumeOAuthState } from "@/lib/oauth-state";
import { db } from "@/lib/db";
import { encryptToken } from "@/lib/crypto";
import { exchangeTikTokCode, fetchTikTokUserInfo, fetchTikTokCreatorInfo } from "@/lib/providers/tiktok";

function redirectToConnections(req: NextRequest, status: "connected" | "error", detail?: string) {
  const url = new URL("/connections", req.nextUrl.origin);
  url.searchParams.set("tiktok", status);
  if (detail) url.searchParams.set("detail", detail);
  return NextResponse.redirect(url);
}

export async function GET(req: NextRequest) {
  const session = await verifySession();

  const searchParams = req.nextUrl.searchParams;
  const error = searchParams.get("error");
  if (error) {
    return redirectToConnections(req, "error", "Autorisation refusée sur TikTok.");
  }

  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const stateValid = await consumeOAuthState("tiktok", state);
  if (!stateValid || !code) {
    return redirectToConnections(req, "error", "Requête invalide ou expirée, réessayez.");
  }

  try {
    const token = await exchangeTikTokCode(code);
    const profile = await fetchTikTokUserInfo(token.access_token);

    // creator_info est facultatif ici (juste pour pré-remplir les métadonnées) : ne bloque pas la connexion s'il échoue.
    let creatorInfo = null;
    try {
      creatorInfo = await fetchTikTokCreatorInfo(token.access_token);
    } catch {
      creatorInfo = null;
    }

    const accessTokenEnc = encryptToken(token.access_token);
    const refreshTokenEnc = encryptToken(token.refresh_token);
    const now = Date.now();

    const existing = await db.socialAccount.findUnique({
      where: { platform_platformAccountId: { platform: "TIKTOK", platformAccountId: profile.open_id } },
    });

    if (existing && existing.userId !== session.userId) {
      return redirectToConnections(req, "error", "Ce compte TikTok est déjà connecté à un autre utilisateur.");
    }

    const data = {
      userId: session.userId,
      username: profile.display_name,
      displayName: profile.display_name,
      avatarUrl: profile.avatar_url,
      accountType: "PERSONAL" as const,
      accessTokenEnc,
      refreshTokenEnc,
      tokenExpiresAt: new Date(now + token.expires_in * 1000),
      refreshExpiresAt: new Date(now + token.refresh_expires_in * 1000),
      grantedScopes: token.scope.split(","),
      status: "ACTIVE" as const,
      lastCheckedAt: new Date(),
      metadata: creatorInfo ? { creatorInfo } : {},
    };

    await db.socialAccount.upsert({
      where: { platform_platformAccountId: { platform: "TIKTOK", platformAccountId: profile.open_id } },
      create: { platform: "TIKTOK", platformAccountId: profile.open_id, ...data },
      update: data,
    });

    await db.activityLog.create({
      data: {
        userId: session.userId,
        entityType: "SocialAccount",
        entityId: profile.open_id,
        action: "tiktok_connected",
        detail: { username: profile.display_name },
      },
    });

    return redirectToConnections(req, "connected");
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erreur inconnue";
    await db.activityLog.create({
      data: {
        userId: session.userId,
        entityType: "SocialAccount",
        entityId: "tiktok",
        action: "tiktok_connect_failed",
        detail: { message },
      },
    });
    return redirectToConnections(req, "error", "La connexion à TikTok a échoué.");
  }
}
