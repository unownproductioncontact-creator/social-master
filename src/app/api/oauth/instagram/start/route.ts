import { NextResponse, type NextRequest } from "next/server";
import { verifySession } from "@/lib/dal";
import { createOAuthState } from "@/lib/oauth-state";
import { buildInstagramAuthorizeUrl } from "@/lib/providers/instagram";

export async function GET(req: NextRequest) {
  await verifySession();

  try {
    const state = await createOAuthState("instagram");
    return NextResponse.redirect(buildInstagramAuthorizeUrl(state));
  } catch (err) {
    // Pas de page 500 brute : retour sur /connections, qui sait déjà afficher l'alerte.
    console.error("[oauth:instagram:start]", err);
    const detail =
      err instanceof Error && err.message.includes("manquants")
        ? "Pas encore disponible : l'application développeur Meta n'est pas configurée sur le serveur (META_APP_ID / META_APP_SECRET). Cette étape viendra une fois le domaine définitif actif."
        : "Erreur inattendue au démarrage de la connexion Instagram.";
    const url = new URL("/connections", req.nextUrl.origin);
    url.searchParams.set("instagram", "error");
    url.searchParams.set("detail", detail);
    return NextResponse.redirect(url);
  }
}
