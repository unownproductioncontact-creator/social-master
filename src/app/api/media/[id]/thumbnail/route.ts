import { NextResponse } from "next/server";
import { verifySession } from "@/lib/dal";
import { db } from "@/lib/db";
import { putObjectBuffer } from "@/lib/storage";

const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024; // 2 Mo — largement suffisant pour un JPEG ~640px

function thumbnailKeyFor(storageKey: string): string {
  return `${storageKey}.thumb.jpg`;
}

/**
 * Reçoit une miniature JPEG générée côté client (capture d'une frame vidéo) et l'attache au
 * MediaAsset. Bonus, jamais bloquant : appelée après un upload principal déjà READY, elle ne doit
 * en aucun cas faire échouer ou remettre en cause cet upload — voir CLAUDE.md règle d'ingénierie
 * (médias jamais en RAM entière : le body binaire ici reste petit, borné par MAX_THUMBNAIL_BYTES,
 * donc un simple arrayBuffer() est acceptable, contrairement aux vidéos/images pleine taille).
 */
export async function POST(req: Request, ctx: RouteContext<"/api/media/[id]/thumbnail">) {
  const session = await verifySession();
  const { id } = await ctx.params;

  const asset = await db.mediaAsset.findUnique({ where: { id } });
  if (!asset || asset.userId !== session.userId) {
    return NextResponse.json({ error: "Média introuvable." }, { status: 404 });
  }

  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.startsWith("image/jpeg")) {
    return NextResponse.json({ error: "Miniature attendue au format JPEG." }, { status: 415 });
  }

  const contentLength = Number(req.headers.get("content-length") ?? 0);
  if (contentLength > 0 && contentLength > MAX_THUMBNAIL_BYTES) {
    return NextResponse.json({ error: "Miniature trop volumineuse." }, { status: 413 });
  }

  let buffer: Buffer;
  try {
    const arrayBuffer = await req.arrayBuffer();
    if (arrayBuffer.byteLength > MAX_THUMBNAIL_BYTES) {
      return NextResponse.json({ error: "Miniature trop volumineuse." }, { status: 413 });
    }
    buffer = Buffer.from(arrayBuffer);
  } catch {
    // Lecture du corps échouée (connexion coupée, etc.) — la miniature est un bonus, on répond
    // simplement par un échec propre sans jamais toucher au statut du MediaAsset.
    return NextResponse.json({ error: "Échec de lecture de la miniature." }, { status: 400 });
  }

  const thumbnailKey = thumbnailKeyFor(asset.storageKey);
  try {
    await putObjectBuffer(thumbnailKey, buffer, "image/jpeg");
    await db.mediaAsset.update({ where: { id }, data: { thumbnailKey } });
  } catch (err) {
    console.error("[thumbnail] envoi/écriture échoué, l'upload principal reste inchangé", err);
    return NextResponse.json({ error: "Échec de l'enregistrement de la miniature." }, { status: 500 });
  }

  return NextResponse.json({ ok: true, thumbnailKey });
}
