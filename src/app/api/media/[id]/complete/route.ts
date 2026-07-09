import { NextResponse } from "next/server";
import { verifySession } from "@/lib/dal";
import { db } from "@/lib/db";
import { headObject } from "@/lib/storage";

export async function POST(_req: Request, ctx: RouteContext<"/api/media/[id]/complete">) {
  const session = await verifySession();
  const { id } = await ctx.params;

  const asset = await db.mediaAsset.findUnique({ where: { id } });
  if (!asset || asset.userId !== session.userId) {
    return NextResponse.json({ error: "Média introuvable." }, { status: 404 });
  }

  // Le client déclare avoir terminé l'upload, mais `sizeBytes` en base vient du navigateur au
  // moment du presign (purement déclaratif — voir mission) : on vérifie ici que l'objet existe
  // vraiment sur R2 avant de faire confiance à ce statut, et on recale la taille sur la réalité.
  const head = await headObject(asset.storageKey);

  if (head.outcome === "not_found") {
    // On laisse volontairement le statut à UPLOADING : un nouvel appel à /complete pourra
    // réussir plus tard si l'upload R2 était simplement encore en vol (cohérence à l'oeil du
    // client), sans jamais faire passer READY un média absent du stockage.
    return NextResponse.json(
      { error: "Fichier introuvable sur le stockage, réessayez l'upload." },
      { status: 409 },
    );
  }

  if (head.outcome === "error") {
    // Tolérant par design (voir mission) : un aléa réseau/R2 ponctuel ne doit pas bloquer
    // l'utilisateur. On journalise pour garder une trace exploitable en cas de souci récurrent.
    console.error("[media/complete] HeadObject R2 a échoué, on accepte quand même", {
      mediaAssetId: id,
      storageKey: asset.storageKey,
      error: head.error,
    });
  }

  const data: { status: "READY"; sizeBytes?: number } = { status: "READY" };
  if (head.outcome === "found" && head.sizeBytes !== asset.sizeBytes) {
    data.sizeBytes = head.sizeBytes;
  }

  await db.mediaAsset.update({ where: { id }, data });

  return NextResponse.json({ ok: true });
}
