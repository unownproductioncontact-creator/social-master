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
    return NextResponse.redirect(new URL("/login", req.nextUrl));
  }

  if ((path === "/login" || path === "/register") && isAuthenticated) {
    return NextResponse.redirect(new URL("/dashboard", req.nextUrl));
  }

  return NextResponse.next();
}

export const config = {
  // `txt`/`ico` exclus pour que les fichiers statiques de public/ (ex. la vérification
  // de domaine TikTok `tiktok*.txt`) soient servis sans passer par la redirection d'auth.
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|svg|webp|txt|ico)$).*)"],
};
