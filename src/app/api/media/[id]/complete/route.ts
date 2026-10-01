import { NextResponse } from "next/server";
import { verifySession } from "@/lib/dal";
import { completeUploadForUser } from "@/lib/media-upload";

/** Upload navigateur → R2 (étape 2) : vérification R2 + READY, logique partagée (src/lib/media-upload.ts). */
export async function POST(_req: Request, ctx: RouteContext<"/api/media/[id]/complete">) {
  const session = await verifySession();
  const { id } = await ctx.params;
  // Le navigateur fournit déjà type et métadonnées au presign : pas de description côté serveur ici.
  const result = await completeUploadForUser(session.userId, id, { describe: false });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  // URL publique (proxy /api/m/) : le composer en masse en a besoin immédiatement pour prévisualiser.
  return NextResponse.json({ ok: true, publicUrl: result.publicUrl });
}
