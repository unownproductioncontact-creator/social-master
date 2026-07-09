"use server";

import * as z from "zod";
import bcrypt from "bcryptjs";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { createSession, deleteSession } from "@/lib/session";
import { checkRateLimit } from "@/lib/rate-limit";

const SALT_ROUNDS = 12;

// Compte unique (usage perso, pas de SaaS pour l'instant — voir CLAUDE.md §1) : pas de header IP
// fiable dans une Server Action, donc pas de clé par IP. Le rate-limiting cible le brute-force
// sur le login (clé par email) et le spam de créations de compte (clé globale, proportionné vu
// qu'un seul compte existera en pratique).
const LOGIN_RATE_LIMIT = { max: 8, windowMs: 15 * 60 * 1000 };
const SIGNUP_RATE_LIMIT = { max: 10, windowMs: 60 * 60 * 1000 };
const SIGNUP_RATE_LIMIT_KEY = "signup";

// Message volontairement identique entre login et signup : ne jamais laisser un message de
// rate-limit trahir si l'email existe déjà (cohérent avec le message générique déjà utilisé par
// login() en cas d'échec, voir plus bas).
function rateLimitMessage(retryAfterSec: number): string {
  const minutes = Math.max(1, Math.ceil(retryAfterSec / 60));
  return `Trop de tentatives, réessayez dans ${minutes} min.`;
}

const SignupSchema = z.object({
  name: z.string().trim().min(1, { error: "Le nom est requis." }),
  email: z.email({ error: "Adresse email invalide." }).trim().toLowerCase(),
  password: z
    .string()
    .min(8, { error: "8 caractères minimum." })
    .regex(/[a-zA-Z]/, { error: "Doit contenir au moins une lettre." })
    .regex(/[0-9]/, { error: "Doit contenir au moins un chiffre." }),
});

const LoginSchema = z.object({
  email: z.email({ error: "Adresse email invalide." }).trim().toLowerCase(),
  password: z.string().min(1, { error: "Mot de passe requis." }),
});

export type AuthFormState =
  | {
      errors?: {
        name?: string[];
        email?: string[];
        password?: string[];
      };
      message?: string;
    }
  | undefined;

export async function signup(_state: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const signupLimit = checkRateLimit(SIGNUP_RATE_LIMIT_KEY, SIGNUP_RATE_LIMIT);
  if (!signupLimit.allowed) {
    return { message: rateLimitMessage(signupLimit.retryAfterSec ?? 3600) };
  }

  const validated = SignupSchema.safeParse({
    name: formData.get("name"),
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!validated.success) {
    return { errors: z.flattenError(validated.error).fieldErrors };
  }

  const { name, email, password } = validated.data;

  const existing = await db.user.findUnique({ where: { email } });
  if (existing) {
    // Message volontairement générique (pas d'erreur ciblée sur le champ email) : ne jamais
    // confirmer qu'un email est déjà pris, même par un timing/formulaire différent — aligné sur
    // le message générique de login() ci-dessous plutôt que sur l'ancien "Un compte existe déjà
    // avec cet email." qui divulguait l'information.
    return { message: "Impossible de créer le compte avec ces informations." };
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  const user = await db.user.create({
    data: { name, email, passwordHash },
    select: { id: true },
  });

  await createSession(user.id);
  redirect("/dashboard");
}

export async function login(_state: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const validated = LoginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!validated.success) {
    return { errors: z.flattenError(validated.error).fieldErrors };
  }

  const { email, password } = validated.data;

  // Clé par email normalisé (déjà lowercased/trimmed par le schéma Zod) : limite le brute-force
  // par cible plutôt que globalement, pour ne pas bloquer un utilisateur légitime à cause des
  // tentatives d'un attaquant visant un autre email.
  const loginLimit = checkRateLimit(`login:${email}`, LOGIN_RATE_LIMIT);
  if (!loginLimit.allowed) {
    return { message: rateLimitMessage(loginLimit.retryAfterSec ?? 900) };
  }

  const user = await db.user.findUnique({ where: { email } });
  if (!user) {
    return { message: "Email ou mot de passe incorrect." };
  }

  const passwordMatches = await bcrypt.compare(password, user.passwordHash);
  if (!passwordMatches) {
    return { message: "Email ou mot de passe incorrect." };
  }

  await createSession(user.id);
  redirect("/dashboard");
}

export async function logout(): Promise<void> {
  await deleteSession();
  redirect("/login");
}
