import { Plus } from "lucide-react";
import { verifySession } from "@/lib/dal";
import { db } from "@/lib/db";
import { SocialAccountCard } from "@/components/connections/social-account-card";
import { editScopeStatus } from "@/lib/youtube-video-edit";
import { insightsScopeStatus, type InstagramStatsState } from "@/lib/instagram-stats";
import { accountsOf } from "@/lib/social-accounts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { PageHeader } from "@/components/layout/page-header";
import { CheckCircle2, AlertTriangle } from "lucide-react";
import type { SocialAccount } from "@/generated/prisma/client";

/** Réseaux affichés, avec le lien de connexion et ce qu'il faut savoir pour AJOUTER un autre compte (§44). */
const PLATFORMS = [
  {
    platform: "INSTAGRAM",
    label: "Instagram",
    connectUrl: "/api/oauth/instagram/start",
    addHint:
      "Instagram connecte le compte ouvert dans ce navigateur : passez d’abord sur l’autre compte dans instagram.com. Il doit être professionnel et ajouté comme testeur Instagram de l’app Meta.",
  },
  {
    platform: "TIKTOK",
    label: "TikTok",
    connectUrl: "/api/oauth/tiktok/start",
    addHint: "TikTok connecte le compte ouvert dans ce navigateur : passez d’abord sur l’autre compte dans tiktok.com.",
  },
  {
    platform: "YOUTUBE",
    label: "YouTube",
    connectUrl: "/api/oauth/youtube/start",
    addHint: "Google vous fait choisir le compte ou la chaîne (y compris une chaîne de marque).",
  },
  // Page Facebook (§40) : une seule Page par connexion, pas d'ajout d'une 2e Page pour l'instant.
  { platform: "FACEBOOK", label: "Facebook", connectUrl: "/api/oauth/facebook/start", addHint: null },
] as const;

function noticeFor(account: SocialAccount): string | undefined {
  if (account.platform === "YOUTUBE" && editScopeStatus(account.grantedScopes) === "missing") {
    return "Nouveau : modifier vos vidéos déjà en ligne (titre, description, visibilité, horaire). Cliquez sur « Reconnecter » et acceptez la modification des vidéos, une seule fois.";
  }
  if (account.platform === "INSTAGRAM") {
    // Statistiques Instagram (§43) : droit à accorder une fois, ou refus constaté au dernier relevé.
    const stats = (account.metadata as { instagramStats?: InstagramStatsState } | null)?.instagramStats;
    if (insightsScopeStatus(account.grantedScopes) === "missing") {
      return "Nouveau : statistiques de vos Reels (vues, portée, partages, taux de zapping). Cliquez sur « Reconnecter » et acceptez l’accès aux statistiques, une seule fois.";
    }
    if (stats?.errorKind === "permission") {
      return "Instagram refuse l’accès aux statistiques. Cliquez sur « Reconnecter » et acceptez l’accès aux statistiques.";
    }
  }
  return undefined;
}

export default async function ConnectionsPage({
  searchParams,
}: {
  searchParams: Promise<{ instagram?: string; tiktok?: string; youtube?: string; facebook?: string; detail?: string }>;
}) {
  const session = await verifySession();
  const params = await searchParams;

  const accounts = await db.socialAccount.findMany({
    where: { userId: session.userId },
    orderBy: { createdAt: "asc" },
  });

  const feedback = params.instagram ?? params.tiktok ?? params.youtube ?? params.facebook;
  const feedbackIsError = feedback === "error";

  return (
    <div className="space-y-4">
      <PageHeader
        title="Connexions"
        description="Connectez vos comptes Instagram, TikTok, YouTube et votre Page Facebook — plusieurs comptes par réseau possibles (ex. une chaîne de clips)."
      />

      {feedback && (
        <Alert variant={feedbackIsError ? "destructive" : "default"}>
          {feedbackIsError ? <AlertTriangle className="size-4" /> : <CheckCircle2 className="size-4" />}
          <AlertTitle className="text-[13px]">
            {feedbackIsError ? "Échec de connexion" : "Compte connecté"}
          </AlertTitle>
          {params.detail && <AlertDescription className="text-[12.5px]">{params.detail}</AlertDescription>}
        </Alert>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        {PLATFORMS.map(({ platform, label, connectUrl, addHint }) => {
          const list = accountsOf(accounts, platform);
          const multi = list.length > 1;
          return (
            <div key={platform} className="space-y-2">
              {list.length === 0 ? (
                <SocialAccountCard platformLabel={label} connectUrl={connectUrl} account={null} />
              ) : (
                list.map((account, index) => (
                  <SocialAccountCard
                    key={account.id}
                    platformLabel={label}
                    connectUrl={connectUrl}
                    account={account}
                    notice={noticeFor(account)}
                    multi={multi}
                    principal={index === 0}
                  />
                ))
              )}
              {list.length > 0 && addHint && (
                <details className="rounded-lg border border-dashed border-border px-3 py-2 text-[12.5px]">
                  <summary className="flex cursor-pointer list-none items-center gap-1.5 font-medium text-primary-strong">
                    <Plus className="size-3.5" />
                    Ajouter un autre compte {label}
                  </summary>
                  <div className="mt-2 space-y-2 text-muted-foreground">
                    <p>{addHint}</p>
                    <p>
                      Le premier compte connecté reste le principal (utilisé quand un post ne précise rien). Donnez un nom à
                      chaque compte (ex. « Clips ») pour le choisir dans le composer et avec Claude.
                    </p>
                    <a href={connectUrl} className="inline-flex items-center gap-1 font-medium text-primary-strong hover:underline">
                      Connecter un autre compte {label} →
                    </a>
                  </div>
                </details>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
