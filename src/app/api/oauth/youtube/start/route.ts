import { NextResponse } from "next/server";
import { verifySession } from "@/lib/dal";
import { createOAuthState } from "@/lib/oauth-state";
import { buildYouTubeAuthorizeUrl } from "@/lib/providers/youtube";
import { appUrl } from "@/lib/app-url";

export async function GET() {
  await verifySession();

  try {
    const state = await createOAuthState("youtube");
    return NextResponse.redirect(buildYouTubeAuthorizeUrl(state));
  } catch (err) {
    // Pas de page 500 brute : retour sur /connections, qui sait déjà afficher l'alerte.
    console.error("[oauth:youtube:start]", err);
    const detail =
      err instanceof Error && err.message.includes("manquants")
        ? "Pas encore disponible : l'application Google (YouTube) n'est pas configurée sur le serveur (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)."
        : "Erreur inattendue au démarrage de la connexion YouTube.";
    const url = new URL("/connections", appUrl());
    url.searchParams.set("youtube", "error");
    url.searchParams.set("detail", detail);
    return NextResponse.redirect(url);
  }
}
