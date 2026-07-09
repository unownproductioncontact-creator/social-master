"use client";

import { useActionState } from "react";
import Link from "next/link";
import { signup } from "@/lib/actions/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function RegisterPage() {
  const [state, action, pending] = useActionState(signup, undefined);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-[19px] tracking-[-0.015em]">Créer un compte</CardTitle>
        <CardDescription className="text-[13px]">Bienvenue sur Social Master.</CardDescription>
      </CardHeader>
      <CardContent>
        <form action={action} className="space-y-3.5">
          <div className="space-y-1.5">
            <Label htmlFor="name" className="text-[12.5px] font-semibold text-foreground">
              Nom
            </Label>
            <Input id="name" name="name" placeholder="Votre nom" required />
            {state?.errors?.name && <p className="text-[13px] text-destructive">{state.errors.name[0]}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="email" className="text-[12.5px] font-semibold text-foreground">
              Email
            </Label>
            <Input id="email" name="email" type="email" placeholder="vous@exemple.fr" required />
            {state?.errors?.email && <p className="text-[13px] text-destructive">{state.errors.email[0]}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="password" className="text-[12.5px] font-semibold text-foreground">
              Mot de passe
            </Label>
            <Input id="password" name="password" type="password" required />
            {state?.errors?.password && (
              <ul className="text-[13px] text-destructive">
                {state.errors.password.map((error) => (
                  <li key={error}>- {error}</li>
                ))}
              </ul>
            )}
          </div>
          {state?.message && <p className="text-[13px] text-destructive">{state.message}</p>}
          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? "Création..." : "Créer mon compte"}
          </Button>
        </form>
        <p className="mt-4 text-center text-[13px] text-muted-foreground">
          Déjà un compte ?{" "}
          <Link href="/login" className="font-semibold text-primary-strong underline underline-offset-4">
            Se connecter
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
