import { NextRequest, NextResponse } from "next/server";
import { decryptSession } from "@/lib/session";

const PUBLIC_ROUTES = ["/login", "/register", "/legal/privacy", "/legal/terms"];

export default async function proxy(req: NextRequest) {
  const path = req.nextUrl.pathname;
  // La page d'accueil publique (`/` exactement — pas `startsWith`, sinon tout deviendrait public) présente
  // le produit et les liens légaux, exigée pour la revue TikTok « site web complet, pas une page de login ».
  const isPublicRoute = path === "/" || PUBLIC_ROUTES.some((route) => path === route || path.startsWith(`${route}/`));

  const cookie = req.cookies.get("session")?.value;
  const session = await decryptSession(cookie);
  const isAuthenticated = Boolean(session?.userId);

  if (!isPublicRoute && !isAuthenticated) {
    // On mémorise la page demandée (?next=) pour y revenir après connexion — indispensable pour le
    // consentement OAuth du connecteur Claude (/oauth/authorize?…, CLAUDE.md §29).
    const loginUrl = new URL("/login", req.nextUrl);
    loginUrl.searchParams.set("next", `${path}${req.nextUrl.search}`);
    return NextResponse.redirect(loginUrl);
  }

  if ((path === "/login" || path === "/register") && isAuthenticated) {
    return NextResponse.redirect(new URL("/dashboard", req.nextUrl));
  }

  return NextResponse.next();
}

export const config = {
  // `txt`/`ico` exclus pour que les fichiers statiques de public/ (ex. la vérification
  // de domaine TikTok `tiktok*.txt`) soient servis sans passer par la redirection d'auth.
  // `.well-known` : métadonnées OAuth publiques du connecteur Claude (RFC 8414 / RFC 9728).
  matcher: ["/((?!api|\\.well-known|_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|svg|webp|txt|ico)$).*)"],
};
