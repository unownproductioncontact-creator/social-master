import Link from "next/link";
import { redirect } from "next/navigation";
import {
  CalendarClock,
  Layers,
  Images,
  Clock3,
  ShieldCheck,
  Sparkles,
  Camera,
  Music2,
} from "lucide-react";
import { getOptionalSession } from "@/lib/dal";
import { BrandMark } from "@/components/layout/brand-mark";
import { buttonVariants } from "@/components/ui/button";

export const metadata = {
  title: "Social Master — Planificateur Instagram & TikTok",
  description:
    "Préparez, programmez et publiez automatiquement vos vidéos et images sur Instagram et TikTok. Calendrier, publication en masse, médiathèque.",
};

const FEATURES = [
  {
    icon: CalendarClock,
    title: "Programmation automatique",
    text: "Préparez vos posts à l'avance et laissez-les partir tout seuls à l'heure choisie. Un calendrier clair, des statuts en temps réel.",
  },
  {
    icon: Layers,
    title: "Publication en masse",
    text: "Importez plusieurs vidéos, réglez légende, hashtags, horaires et plateformes pour tout le lot, puis programmez d'un coup.",
  },
  {
    icon: Clock3,
    title: "Horaires par plateforme",
    text: "Un même post, deux moments : par exemple TikTok à 18h00 et Instagram à 18h05. À la minute près, pour chaque réseau.",
  },
  {
    icon: Images,
    title: "Médiathèque",
    text: "Vos vidéos et images au même endroit, avec miniatures et compatibilité vérifiée par plateforme (format, ratio, durée).",
  },
  {
    icon: Sparkles,
    title: "Formats complets",
    text: "Reels, images, Stories et carrousels pour Instagram ; vidéos et posts photo pour TikTok. Couverture de Reel au choix.",
  },
  {
    icon: ShieldCheck,
    title: "Vos comptes en sécurité",
    text: "Vos jetons d'accès sont chiffrés, jamais exposés. Vous restez maître de vos connexions et pouvez vous déconnecter à tout moment.",
  },
];

const STEPS = [
  {
    n: "1",
    title: "Connectez vos comptes",
    text: "Reliez votre compte Instagram professionnel et votre compte TikTok en quelques clics, en toute sécurité.",
  },
  {
    n: "2",
    title: "Préparez et programmez",
    text: "Uploadez vos médias, écrivez légende et hashtags, choisissez les plateformes et l'heure de publication.",
  },
  {
    n: "3",
    title: "L'app publie pour vous",
    text: "À l'heure dite, Social Master publie sur Instagram et dépose vos vidéos TikTok prêtes à finaliser. Vous suivez tout dans l'historique.",
  },
];

const FAQ = [
  {
    q: "Quels réseaux sont pris en charge ?",
    a: "Instagram (Reels, images, Stories, carrousels) et TikTok (vidéos et posts photo). Un compte Instagram professionnel (Business ou Créateur) est requis pour la publication.",
  },
  {
    q: "Comment fonctionne la publication TikTok ?",
    a: "Vos vidéos sont déposées en brouillon dans votre boîte de réception TikTok ; vous les finalisez et publiez depuis l'application TikTok, en gardant la main sur la confidentialité et le son.",
  },
  {
    q: "Mes identifiants sont-ils en sécurité ?",
    a: "Social Master ne voit jamais votre mot de passe : la connexion passe par les protocoles officiels d'Instagram et de TikTok. Les jetons d'accès sont chiffrés et ne quittent jamais nos serveurs.",
  },
  {
    q: "Puis-je modifier ou annuler un post programmé ?",
    a: "Oui. Tant qu'un post n'est pas parti, vous pouvez le repasser en brouillon, le modifier ou le supprimer depuis le calendrier ou l'historique.",
  },
];

export default async function RootPage() {
  const session = await getOptionalSession();
  if (session?.userId) redirect("/dashboard");

  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground">
      {/* En-tête */}
      <header className="sticky top-0 z-10 border-b border-border bg-background/80 backdrop-blur-sm">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
          <BrandMark />
          <nav className="flex items-center gap-2">
            <Link href="/login" className={buttonVariants({ variant: "ghost", size: "sm" })}>
              Se connecter
            </Link>
            <Link href="/register" className={buttonVariants({ variant: "default", size: "sm" })}>
              Créer un compte
            </Link>
          </nav>
        </div>
      </header>

      <main className="flex-1">
        {/* Hero */}
        <section className="mx-auto max-w-5xl px-4 py-16 sm:py-24 text-center">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-accent-border bg-accent-strong px-3 py-1 text-[12px] font-semibold text-primary-strong">
            <Camera className="size-3.5" /> Instagram
            <span className="text-muted-foreground">·</span>
            <Music2 className="size-3.5" /> TikTok
          </span>
          <h1 className="mx-auto mt-5 max-w-2xl text-balance text-3xl font-bold tracking-tight sm:text-5xl">
            Planifiez vos publications Instagram &amp; TikTok, sans y penser.
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-pretty text-[15px] leading-relaxed text-muted-foreground sm:text-base">
            Préparez vos vidéos et images une bonne fois, programmez-les, et laissez Social Master
            les publier au bon moment sur les deux plateformes. Calendrier, publication en masse, médiathèque.
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link href="/register" className={buttonVariants({ variant: "default", size: "lg" })}>
              Créer un compte gratuit
            </Link>
            <Link href="/login" className={buttonVariants({ variant: "outline", size: "lg" })}>
              J'ai déjà un compte
            </Link>
          </div>
        </section>

        {/* Fonctionnalités */}
        <section className="border-t border-border bg-muted/30 py-16">
          <div className="mx-auto max-w-5xl px-4">
            <h2 className="text-center text-2xl font-semibold tracking-tight">Tout ce qu'il faut pour publier régulièrement</h2>
            <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {FEATURES.map((f) => (
                <div key={f.title} className="rounded-xl border border-border bg-card p-5">
                  <div className="flex size-9 items-center justify-center rounded-lg bg-accent-strong text-primary-strong">
                    <f.icon className="size-4.5" />
                  </div>
                  <h3 className="mt-3 text-[15px] font-semibold">{f.title}</h3>
                  <p className="mt-1.5 text-[13.5px] leading-relaxed text-muted-foreground">{f.text}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Comment ça marche */}
        <section className="py-16">
          <div className="mx-auto max-w-5xl px-4">
            <h2 className="text-center text-2xl font-semibold tracking-tight">Comment ça marche</h2>
            <div className="mt-10 grid gap-6 sm:grid-cols-3">
              {STEPS.map((s) => (
                <div key={s.n} className="text-center">
                  <div className="mx-auto flex size-10 items-center justify-center rounded-full bg-brand-gradient text-base font-bold text-primary-foreground">
                    {s.n}
                  </div>
                  <h3 className="mt-4 text-[15px] font-semibold">{s.title}</h3>
                  <p className="mx-auto mt-1.5 max-w-xs text-[13.5px] leading-relaxed text-muted-foreground">{s.text}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* FAQ */}
        <section className="border-t border-border bg-muted/30 py-16">
          <div className="mx-auto max-w-2xl px-4">
            <h2 className="text-center text-2xl font-semibold tracking-tight">Questions fréquentes</h2>
            <dl className="mt-8 space-y-3">
              {FAQ.map((item) => (
                <div key={item.q} className="rounded-xl border border-border bg-card p-4">
                  <dt className="text-[14px] font-semibold">{item.q}</dt>
                  <dd className="mt-1.5 text-[13.5px] leading-relaxed text-muted-foreground">{item.a}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        {/* Appel à l'action final */}
        <section className="py-16 text-center">
          <div className="mx-auto max-w-2xl px-4">
            <h2 className="text-2xl font-semibold tracking-tight">Prêt à gagner du temps ?</h2>
            <p className="mx-auto mt-2 max-w-md text-[14px] text-muted-foreground">
              Créez votre compte et connectez vos réseaux en quelques minutes.
            </p>
            <Link href="/register" className={`${buttonVariants({ variant: "default", size: "lg" })} mt-6`}>
              Commencer
            </Link>
          </div>
        </section>
      </main>

      {/* Pied de page — liens légaux visibles (exigence des plateformes) */}
      <footer className="border-t border-border py-8">
        <div className="mx-auto flex max-w-5xl flex-col items-center justify-between gap-4 px-4 sm:flex-row">
          <BrandMark />
          <nav className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-[13px] text-muted-foreground">
            <Link href="/legal/privacy" className="hover:text-foreground hover:underline underline-offset-4">
              Confidentialité
            </Link>
            <Link href="/legal/terms" className="hover:text-foreground hover:underline underline-offset-4">
              Conditions d'utilisation
            </Link>
            <a
              href="mailto:unownproduction.contact@gmail.com"
              className="hover:text-foreground hover:underline underline-offset-4"
            >
              Contact
            </a>
          </nav>
        </div>
        <p className="mt-6 text-center text-[12px] text-muted-foreground">
          © 2026 Social Master — édité par MEA (SASU). Tous droits réservés.
        </p>
      </footer>
    </div>
  );
}
