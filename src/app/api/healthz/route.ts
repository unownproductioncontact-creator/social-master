import { NextResponse } from "next/server";
import { db } from "@/lib/db";

// SHA du commit déployé, exposé pour vérifier de façon fiable QUEL build tourne en prod (Render
// renseigne RENDER_GIT_COMMIT automatiquement). Permet `curl …/api/healthz` → comparer au HEAD local
// au lieu de deviner via des empreintes d'assets (les changements de pages authentifiées n'ont aucun
// marqueur public). `null` en local/dev où la variable n'existe pas.
const COMMIT = process.env.RENDER_GIT_COMMIT?.slice(0, 7) ?? null;

export async function GET() {
  try {
    await db.$queryRaw`SELECT 1`;
    return NextResponse.json({ status: "ok", time: new Date().toISOString(), commit: COMMIT });
  } catch {
    return NextResponse.json({ status: "error", commit: COMMIT }, { status: 503 });
  }
}
