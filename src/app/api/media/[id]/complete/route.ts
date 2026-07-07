import { NextResponse } from "next/server";
import { verifySession } from "@/lib/dal";
import { db } from "@/lib/db";

export async function POST(_req: Request, ctx: RouteContext<"/api/media/[id]/complete">) {
  const session = await verifySession();
  const { id } = await ctx.params;

  const asset = await db.mediaAsset.findUnique({ where: { id } });
  if (!asset || asset.userId !== session.userId) {
    return NextResponse.json({ error: "Média introuvable." }, { status: 404 });
  }

  await db.mediaAsset.update({ where: { id }, data: { status: "READY" } });

  return NextResponse.json({ ok: true });
}
