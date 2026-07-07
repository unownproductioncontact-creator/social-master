"use server";

import * as z from "zod";
import bcrypt from "bcryptjs";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { createSession, deleteSession } from "@/lib/session";

const SALT_ROUNDS = 12;

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
    return { errors: { email: ["Un compte existe déjà avec cet email."] } };
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
