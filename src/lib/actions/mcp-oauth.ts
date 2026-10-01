"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { verifySession } from "@/lib/dal";
import { db } from "@/lib/db";
import { buildRedirect } from "@/lib/mcp/oauth-core";
import { createAuthorizationCode, revokeGrant } from "@/lib/mcp/oauth-store";
import { authorizeParamsFromForm, validateAuthorizeRequest } from "@/lib/mcp/authorize-request";

/** « Autoriser » sur la page de consentement : émet un code pour l'utilisateur CONNECTÉ, puis retour au client. */
export async function approveMcpAuthorization(formData: FormData): Promise<void> {
  const session = await verifySession();
  if (!(await db.user.findUnique({ where: { id: session.userId }, select: { id: true } }))) redirect("/login");
  const v = await validateAuthorizeRequest(authorizeParamsFromForm(formData));
  if (!v.ok) {
    if ("fatal" in v) redirect("/dashboard");
    redirect(buildRedirect(v.redirectUri, { error: v.redirectError, state: v.state }));
  }
  const code = await createAuthorizationCode({
    clientId: v.clientId,
    userId: session.userId,
    redirectUri: v.redirectUri,
    codeChallenge: v.codeChallenge,
  });
  redirect(buildRedirect(v.redirectUri, { code, state: v.state }));
}

/** « Refuser » : retour au client avec access_denied, aucun code émis. */
export async function denyMcpAuthorization(formData: FormData): Promise<void> {
  await verifySession();
  const v = await validateAuthorizeRequest(authorizeParamsFromForm(formData));
  if (!v.ok && "fatal" in v) redirect("/dashboard");
  redirect(buildRedirect(v.redirectUri, { error: "access_denied", state: v.state }));
}

/** Paramètres → Claude : révoque un accès (jeton d'accès + refresh token, effet immédiat). */
export async function revokeClaudeAccess(tokenId: string): Promise<{ error?: string }> {
  const session = await verifySession();
  const ok = await revokeGrant(session.userId, tokenId);
  revalidatePath("/settings");
  return ok ? {} : { error: "Accès introuvable ou déjà révoqué." };
}
