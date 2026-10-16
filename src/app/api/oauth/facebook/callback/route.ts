import { NextRequest, NextResponse } from "next/server";
import { verifySession } from "@/lib/dal";
import { consumeOAuthState } from "@/lib/oauth-state";
import { db } from "@/lib/db";
import { encryptToken } from "@/lib/crypto";
import {
  canPublishOnPage,
  exchangeFacebookCode,
  exchangeLongLivedUserToken,
  fetchGrantedPermissions,
  fetchManagedPages,
} from "@/lib/providers/facebook";
import { appUrl } from "@/lib/app-url";

/**
 * Retour de la connexion Facebook (CLAUDE.md §40) : jeton utilisateur → jeton long → Pages gérées → on
 * enregistre UNE Page (celle déjà connectée si elle est encore proposée, sinon la première où l'on peut
 * publier) avec son jeton de Page, qui n'expire pas. Le jeton utilisateur n'est pas conservé.
 */
function redirectToConnections(status: "connected" | "error", detail?: string) {
  // APP_URL et jamais l'origin de la requête (hôte interne derrière le proxy Render).
  const url = new URL("/connections", appUrl());
  url.searchParams.set("facebook", status);
  if (detail) url.searchParams.set("detail", detail);
  return NextResponse.redirect(url);
}

export async function GET(req: NextRequest) {
  const session = await verifySession();

  const searchParams = req.nextUrl.searchParams;
  if (searchParams.get("error") || searchParams.get("error_reason")) {
    return redirectToConnections("error", "Autorisation refusée sur Facebook.");
  }

  const code = searchParams.get("code");
  const stateValid = await consumeOAuthState("facebook", searchParams.get("state"));
  if (!stateValid || !code) {
    return redirectToConnections("error", "Requête invalide ou expirée, réessayez.");
  }

  try {
    const shortLived = await exchangeFacebookCode(code);
    const longLived = await exchangeLongLivedUserToken(shortLived.access_token);
    const permissions = await fetchGrantedPermissions(longLived.access_token);
    if (!permissions.includes("pages_manage_posts")) {
      return redirectToConnections(
        "error",
        "Autorisation « publier sur la Page » non accordée : reconnectez Facebook en acceptant toutes les autorisations."
      );
    }

    const pages = (await fetchManagedPages(longLived.access_token)).filter(canPublishOnPage);
    if (pages.length === 0) {
      return redirectToConnections(
        "error",
        "Aucune Page Facebook où vous pouvez publier n'a été partagée avec Social Master : pendant la connexion, cochez votre Page."
      );
    }
    const previous = await db.socialAccount.findMany({
      where: { userId: session.userId, platform: "FACEBOOK" },
      select: { platformAccountId: true },
    });
    const page = pages.find((p) => previous.some((a) => a.platformAccountId === p.id)) ?? pages[0];

    const existing = await db.socialAccount.findUnique({
      where: { platform_platformAccountId: { platform: "FACEBOOK", platformAccountId: page.id } },
    });
    if (existing && existing.userId !== session.userId) {
      return redirectToConnections("error", "Cette Page Facebook est déjà connectée à un autre utilisateur.");
    }

    const data = {
      username: page.name,
      displayName: page.name,
      avatarUrl: page.pictureUrl ?? null,
      accessTokenEnc: encryptToken(page.accessToken),
      refreshTokenEnc: null,
      tokenExpiresAt: null,
      grantedScopes: permissions,
      status: "ACTIVE" as const,
      lastCheckedAt: new Date(),
    };
    await db.socialAccount.upsert({
      where: { platform_platformAccountId: { platform: "FACEBOOK", platformAccountId: page.id } },
      create: { userId: session.userId, platform: "FACEBOOK", platformAccountId: page.id, ...data },
      update: data,
    });

    await db.activityLog.create({
      data: {
        userId: session.userId,
        entityType: "SocialAccount",
        entityId: page.id,
        action: "facebook_connected",
        detail: { page: page.name, pagesAvailable: pages.length },
      },
    });

    return redirectToConnections(
      "connected",
      pages.length > 1 ? `Page « ${page.name} » connectée (vous gérez ${pages.length} Pages).` : `Page « ${page.name} » connectée.`
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erreur inconnue";
    await db.activityLog.create({
      data: {
        userId: session.userId,
        entityType: "SocialAccount",
        entityId: "facebook",
        action: "facebook_connect_failed",
        detail: { message },
      },
    });
    return redirectToConnections("error", "La connexion à Facebook a échoué.");
  }
}
