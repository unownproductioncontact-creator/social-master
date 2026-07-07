import { NextResponse } from "next/server";
import { verifySession } from "@/lib/dal";
import { createOAuthState } from "@/lib/oauth-state";
import { buildInstagramAuthorizeUrl } from "@/lib/providers/instagram";

export async function GET() {
  await verifySession();

  const state = await createOAuthState("instagram");
  const authorizeUrl = buildInstagramAuthorizeUrl(state);

  return NextResponse.redirect(authorizeUrl);
}
