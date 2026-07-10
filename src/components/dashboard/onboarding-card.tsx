import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Card } from "@/components/ui/card";
import { BrandMark } from "@/components/layout/brand-mark";

const STEPS: { href: string; title: string }[] = [
  { href: "/connections", title: "Connecter Instagram et TikTok" },
  { href: "/library", title: "Importer une vidéo" },
  { href: "/composer", title: "Programmer votre premier post" },
];

/**
 * Carte « Premiers pas » (P2-8) : affichée en tête de tableau de bord tant qu'aucun compte social
 * n'est connecté (accounts.length === 0). Trois étapes numérotées vers les pages clés, plus un
 * rappel du mode brouillon TikTok pour que le user ne soit pas surpris au premier envoi.
 */
export function OnboardingCard() {
  return (
    <Card className="gap-0 py-0">
      <div className="border-b border-border px-[15px] py-3">
        <BrandMark />
        <p className="mt-2 text-[12.5px] text-muted-foreground">
          Trois étapes pour programmer votre première publication.
        </p>
      </div>
      <div className="flex flex-col">
        {STEPS.map((step, i) => (
          <Link
            key={step.href}
            href={step.href}
            className="flex items-center gap-3 border-b border-border px-[15px] py-[11px] last:border-b-0 transition-colors hover:bg-muted/50"
          >
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-brand-gradient text-[11.5px] font-bold text-primary-foreground">
              {i + 1}
            </span>
            <span className="flex-1 text-[13.5px] font-semibold">{step.title}</span>
            <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
          </Link>
        ))}
      </div>
      <p className="border-t border-border px-[15px] py-2.5 text-[11.5px] text-muted-foreground">
        Les vidéos TikTok arrivent en brouillon dans vos notifications TikTok : vous finalisez la
        publication dans l’app.
      </p>
    </Card>
  );
}
