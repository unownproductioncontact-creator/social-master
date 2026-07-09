"use client";

import { useActionState } from "react";
import Link from "next/link";
import { login } from "@/lib/actions/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function LoginPage() {
  const [state, action, pending] = useActionState(login, undefined);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-[19px] tracking-[-0.015em]">Connexion</CardTitle>
        <CardDescription className="text-[13px]">Accédez à votre espace Social Master.</CardDescription>
      </CardHeader>
      <CardContent>
        <form action={action} className="space-y-3.5">
          <div className="space-y-1.5">
            <Label htmlFor="email" className="text-[12.5px] font-semibold text-foreground">
              Email
            </Label>
            <Input id="email" name="email" type="email" placeholder="vous@exemple.fr" required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="password" className="text-[12.5px] font-semibold text-foreground">
              Mot de passe
            </Label>
            <Input id="password" name="password" type="password" required />
          </div>
          {state?.message && <p className="text-[13px] text-destructive">{state.message}</p>}
          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? "Connexion..." : "Se connecter"}
          </Button>
        </form>
        <p className="mt-4 text-center text-[13px] text-muted-foreground">
          Pas encore de compte ?{" "}
          <Link href="/register" className="font-semibold text-primary-strong underline underline-offset-4">
            Créer un compte
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
