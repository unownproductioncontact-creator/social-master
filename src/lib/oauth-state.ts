import "server-only";
import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";

const STATE_COOKIE_PREFIX = "oauth_state_";
const STATE_TTL_SECONDS = 10 * 60; // 10 minutes suffisent pour un flow OAuth

/** Génère un state anti-CSRF et le stocke dans un cookie httpOnly de courte durée. */
export async function createOAuthState(provider: string): Promise<string> {
  const state = randomBytes(24).toString("base64url");
  const cookieStore = await cookies();
  cookieStore.set(`${STATE_COOKIE_PREFIX}${provider}`, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: STATE_TTL_SECONDS,
    path: "/",
  });
  return state;
}

/** Vérifie le state reçu au callback contre le cookie, puis le supprime (usage unique). */
export async function consumeOAuthState(provider: string, receivedState: string | null): Promise<boolean> {
  const cookieStore = await cookies();
  const cookieName = `${STATE_COOKIE_PREFIX}${provider}`;
  const expected = cookieStore.get(cookieName)?.value;
  cookieStore.delete(cookieName);

  if (!expected || !receivedState) return false;
  return expected === receivedState;
}
