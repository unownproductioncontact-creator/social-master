import { NextResponse } from "next/server";
import { verifySession } from "@/lib/dal";
import { createOAuthState } from "@/lib/oauth-state";
import { buildFacebookAuthorizeUrl } from "@/lib/providers/facebook";
import { appUrl } from "@/lib/app-url";

export async function GET() {
  await verifySession();

  try {
    const state = await createOAuthState("facebook");
    return NextResponse.redirect(buildFacebookAuthorizeUrl(state));
  } catch (err) {
    // Pas de page 500 brute : retour sur /connections, qui sait déjà afficher l'alerte.
    console.error("[oauth:facebook:start]", err);
    const detail =
      err instanceof Error && err.message.includes("manquants")
        ? "Pas encore disponible : l'application Meta n'est pas configurée sur le serveur (FACEBOOK_APP_ID / FACEBOOK_APP_SECRET)."
        : "Erreur inattendue au démarrage de la connexion Facebook.";
    const url = new URL("/connections", appUrl());
    url.searchParams.set("facebook", "error");
    url.searchParams.set("detail", detail);
    return NextResponse.redirect(url);
  }
}
