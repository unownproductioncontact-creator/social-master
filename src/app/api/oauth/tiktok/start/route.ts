import { NextResponse } from "next/server";
import { verifySession } from "@/lib/dal";
import { createOAuthState } from "@/lib/oauth-state";
import { buildTikTokAuthorizeUrl } from "@/lib/providers/tiktok";
import { appUrl } from "@/lib/app-url";

export async function GET() {
  await verifySession();

  try {
    const state = await createOAuthState("tiktok");
    return NextResponse.redirect(buildTikTokAuthorizeUrl(state));
  } catch (err) {
    // Pas de page 500 brute : retour sur /connections, qui sait déjà afficher l'alerte.
    console.error("[oauth:tiktok:start]", err);
    const detail =
      err instanceof Error && err.message.includes("manquants")
        ? "Pas encore disponible : l'application développeur TikTok n'est pas configurée sur le serveur (TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET). Cette étape viendra une fois le domaine définitif actif."
        : "Erreur inattendue au démarrage de la connexion TikTok.";
    const url = new URL("/connections", appUrl());
    url.searchParams.set("tiktok", "error");
    url.searchParams.set("detail", detail);
    return NextResponse.redirect(url);
  }
}
