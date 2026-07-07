import { NextResponse } from "next/server";
import { verifySession } from "@/lib/dal";
import { createOAuthState } from "@/lib/oauth-state";
import { buildTikTokAuthorizeUrl } from "@/lib/providers/tiktok";

export async function GET() {
  await verifySession();

  const state = await createOAuthState("tiktok");
  const authorizeUrl = buildTikTokAuthorizeUrl(state);

  return NextResponse.redirect(authorizeUrl);
}
