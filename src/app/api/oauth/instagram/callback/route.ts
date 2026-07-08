import { NextRequest, NextResponse } from "next/server";
import { verifySession } from "@/lib/dal";
import { consumeOAuthState } from "@/lib/oauth-state";
import { db } from "@/lib/db";
import { encryptToken } from "@/lib/crypto";
import {
  exchangeCodeForShortLivedToken,
  exchangeForLongLivedToken,
  fetchInstagramProfile,
  mapInstagramAccountType,
} from "@/lib/providers/instagram";
import { appUrl } from "@/lib/app-url";

function redirectToConnections(req: NextRequest, status: "connected" | "error", detail?: string) {
  // req.nextUrl.origin reflète l'hôte interne vu par Next.js (ex. localhost:10000 sur Render,
  // derrière son proxy) et non le domaine public — utiliser APP_URL, jamais l'origin de la requête.
  const url = new URL("/connections", appUrl());
  url.searchParams.set("instagram", status);
  if (detail) url.searchParams.set("detail", detail);
  return NextResponse.redirect(url);
}

export async function GET(req: NextRequest) {
  const session = await verifySession();

  const searchParams = req.nextUrl.searchParams;
  const error = searchParams.get("error") || searchParams.get("error_reason");
  if (error) {
    return redirectToConnections(req, "error", "Autorisation refusée sur Instagram.");
  }

  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const stateValid = await consumeOAuthState("instagram", state);
  if (!stateValid || !code) {
    return redirectToConnections(req, "error", "Requête invalide ou expirée, réessayez.");
  }

  try {
    const shortLived = await exchangeCodeForShortLivedToken(code);
    const longLived = await exchangeForLongLivedToken(shortLived.access_token);
    const profile = await fetchInstagramProfile(longLived.access_token);

    const expiresAt = new Date(Date.now() + longLived.expires_in * 1000);
    const accessTokenEnc = encryptToken(longLived.access_token);

    const existing = await db.socialAccount.findUnique({
      where: { platform_platformAccountId: { platform: "INSTAGRAM", platformAccountId: profile.user_id } },
    });

    if (existing && existing.userId !== session.userId) {
      return redirectToConnections(req, "error", "Ce compte Instagram est déjà connecté à un autre utilisateur.");
    }

    await db.socialAccount.upsert({
      where: { platform_platformAccountId: { platform: "INSTAGRAM", platformAccountId: profile.user_id } },
      create: {
        userId: session.userId,
        platform: "INSTAGRAM",
        platformAccountId: profile.user_id,
        username: profile.username,
        displayName: profile.name,
        avatarUrl: profile.profile_picture_url,
        accountType: mapInstagramAccountType(profile.account_type),
        accessTokenEnc,
        tokenExpiresAt: expiresAt,
        grantedScopes: shortLived.permissions ?? [],
        status: "ACTIVE",
        lastCheckedAt: new Date(),
      },
      update: {
        username: profile.username,
        displayName: profile.name,
        avatarUrl: profile.profile_picture_url,
        accountType: mapInstagramAccountType(profile.account_type),
        accessTokenEnc,
        tokenExpiresAt: expiresAt,
        grantedScopes: shortLived.permissions ?? [],
        status: "ACTIVE",
        lastCheckedAt: new Date(),
      },
    });

    await db.activityLog.create({
      data: {
        userId: session.userId,
        entityType: "SocialAccount",
        entityId: profile.user_id,
        action: "instagram_connected",
        detail: { username: profile.username },
      },
    });

    return redirectToConnections(req, "connected");
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erreur inconnue";
    await db.activityLog.create({
      data: {
        userId: session.userId,
        entityType: "SocialAccount",
        entityId: "instagram",
        action: "instagram_connect_failed",
        detail: { message },
      },
    });
    return redirectToConnections(req, "error", "La connexion à Instagram a échoué.");
  }
}
