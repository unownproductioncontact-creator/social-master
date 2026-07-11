import { NextRequest, NextResponse } from "next/server";
import { verifySession } from "@/lib/dal";
import { consumeOAuthState } from "@/lib/oauth-state";
import { db } from "@/lib/db";
import { encryptToken } from "@/lib/crypto";
import { exchangeYouTubeCode, fetchYouTubeChannel } from "@/lib/providers/youtube";
import { appUrl } from "@/lib/app-url";

function redirectToConnections(req: NextRequest, status: "connected" | "error", detail?: string) {
  // req.nextUrl.origin reflète l'hôte interne vu par Next.js (ex. localhost:10000 sur Render, derrière
  // son proxy) et non le domaine public — utiliser APP_URL, jamais l'origin de la requête (cf. callback TikTok).
  const url = new URL("/connections", appUrl());
  url.searchParams.set("youtube", status);
  if (detail) url.searchParams.set("detail", detail);
  return NextResponse.redirect(url);
}

export async function GET(req: NextRequest) {
  const session = await verifySession();

  const searchParams = req.nextUrl.searchParams;
  const error = searchParams.get("error");
  if (error) {
    return redirectToConnections(req, "error", "Autorisation refusée sur YouTube.");
  }

  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const stateValid = await consumeOAuthState("youtube", state);
  if (!stateValid || !code) {
    return redirectToConnections(req, "error", "Requête invalide ou expirée, réessayez.");
  }

  try {
    const token = await exchangeYouTubeCode(code);

    // ⚠️ Google ne renvoie un refresh_token QUE si l'utilisateur consent pleinement. S'il avait déjà
    // consenti lors d'une session précédente SANS prompt=consent (ex. via une autre app du même projet
    // Google Cloud, partagé avec Kiibiki — CLAUDE.md §25), le refresh_token peut manquer. Sans lui, le
    // planificateur ne peut pas rafraîchir le token avant chaque publication : on refuse explicitement.
    if (!token.refresh_token) {
      return redirectToConnections(
        req,
        "error",
        "Consentement incomplet : YouTube n'a pas fourni de jeton de rafraîchissement. Réessayez en acceptant tous les accès demandés (consentement complet requis)."
      );
    }

    const channel = await fetchYouTubeChannel(token.access_token);

    const accessTokenEnc = encryptToken(token.access_token);
    const refreshTokenEnc = encryptToken(token.refresh_token);
    const now = Date.now();

    const existing = await db.socialAccount.findUnique({
      where: { platform_platformAccountId: { platform: "YOUTUBE", platformAccountId: channel.id } },
    });

    if (existing && existing.userId !== session.userId) {
      return redirectToConnections(req, "error", "Cette chaîne YouTube est déjà connectée à un autre utilisateur.");
    }

    const data = {
      userId: session.userId,
      username: channel.title,
      displayName: channel.title,
      avatarUrl: channel.thumbnailUrl,
      accountType: "CREATOR" as const,
      accessTokenEnc,
      refreshTokenEnc,
      // Access token ~1h. Le refresh token Google n'expire pas en usage régulier (projet en production
      // non vérifiée, cf. §25) → pas de refreshExpiresAt fiable à poser, laissé nul.
      tokenExpiresAt: new Date(now + token.expires_in * 1000),
      grantedScopes: token.scope ? token.scope.split(" ").filter(Boolean) : [],
      status: "ACTIVE" as const,
      lastCheckedAt: new Date(),
    };

    await db.socialAccount.upsert({
      where: { platform_platformAccountId: { platform: "YOUTUBE", platformAccountId: channel.id } },
      create: { platform: "YOUTUBE", platformAccountId: channel.id, ...data },
      update: data,
    });

    await db.activityLog.create({
      data: {
        userId: session.userId,
        entityType: "SocialAccount",
        entityId: channel.id,
        action: "youtube_connected",
        detail: { username: channel.title },
      },
    });

    return redirectToConnections(req, "connected");
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erreur inconnue";
    await db.activityLog.create({
      data: {
        userId: session.userId,
        entityType: "SocialAccount",
        entityId: "youtube",
        action: "youtube_connect_failed",
        detail: { message },
      },
    });
    return redirectToConnections(req, "error", "La connexion à YouTube a échoué.");
  }
}
