import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { decryptSession, getSessionCookie } from "@/lib/session";
import { db } from "@/lib/db";

export const verifySession = cache(async () => {
  const token = await getSessionCookie();
  const session = await decryptSession(token);

  if (!session?.userId) {
    redirect("/login");
  }

  return { isAuth: true, userId: session.userId };
});

/** Comme verifySession(), mais retourne null au lieu de rediriger — pour les routes/actions publiques. */
export const getOptionalSession = cache(async () => {
  const token = await getSessionCookie();
  return decryptSession(token);
});

export const getCurrentUser = cache(async () => {
  const session = await verifySession();

  try {
    const user = await db.user.findUnique({
      where: { id: session.userId },
      select: { id: true, email: true, name: true, timezone: true },
    });
    return user;
  } catch {
    return null;
  }
});
