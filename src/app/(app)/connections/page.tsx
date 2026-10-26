import { verifySession } from "@/lib/dal";
import { db } from "@/lib/db";
import { SocialAccountCard } from "@/components/connections/social-account-card";
import { editScopeStatus } from "@/lib/youtube-video-edit";
import { insightsScopeStatus, type InstagramStatsState } from "@/lib/instagram-stats";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { PageHeader } from "@/components/layout/page-header";
import { CheckCircle2, AlertTriangle } from "lucide-react";

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

  const instagramAccount = accounts.find((a) => a.platform === "INSTAGRAM") ?? null;
  const tiktokAccount = accounts.find((a) => a.platform === "TIKTOK") ?? null;
  const youtubeAccount = accounts.find((a) => a.platform === "YOUTUBE") ?? null;
  // Page Facebook (§40) : la plus récemment connectée (la connexion n'en garde qu'une à la fois).
  const facebookAccount =
    accounts.filter((a) => a.platform === "FACEBOOK").sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0] ?? null;

  // Statistiques Instagram (§43) : droit à accorder une fois, ou refus constaté au dernier relevé.
  const instagramStats = (instagramAccount?.metadata as { instagramStats?: InstagramStatsState } | null)?.instagramStats;
  const instagramNotice = !instagramAccount
    ? undefined
    : insightsScopeStatus(instagramAccount.grantedScopes) === "missing"
      ? "Nouveau : statistiques de vos Reels (vues, portée, partages, taux de zapping). Cliquez sur « Reconnecter » et acceptez l’accès aux statistiques, une seule fois."
      : instagramStats?.errorKind === "permission"
        ? "Instagram refuse l’accès aux statistiques. Cliquez sur « Reconnecter » et acceptez l’accès aux statistiques."
        : undefined;

  const feedback = params.instagram ?? params.tiktok ?? params.youtube ?? params.facebook;
  const feedbackIsError = feedback === "error";

  return (
    <div className="space-y-4">
      <PageHeader title="Connexions" description="Connectez vos comptes Instagram, TikTok, YouTube et votre Page Facebook." />

      {feedback && (
        <Alert variant={feedbackIsError ? "destructive" : "default"}>
          {feedbackIsError ? <AlertTriangle className="size-4" /> : <CheckCircle2 className="size-4" />}
          <AlertTitle className="text-[13.5px] font-semibold">
            {feedbackIsError ? "Échec de connexion" : "Compte connecté"}
          </AlertTitle>
          {params.detail && <AlertDescription className="text-[12.5px]">{params.detail}</AlertDescription>}
        </Alert>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <SocialAccountCard
          platformLabel="Instagram"
          connectUrl="/api/oauth/instagram/start"
          account={instagramAccount}
          notice={instagramNotice}
        />
        <SocialAccountCard
          platformLabel="TikTok"
          connectUrl="/api/oauth/tiktok/start"
          account={tiktokAccount}
        />
        <SocialAccountCard
          platformLabel="YouTube"
          connectUrl="/api/oauth/youtube/start"
          account={youtubeAccount}
          notice={
            youtubeAccount && editScopeStatus(youtubeAccount.grantedScopes) === "missing"
              ? "Nouveau : modifier vos vidéos déjà en ligne (titre, description, visibilité, horaire). Cliquez sur « Reconnecter » et acceptez la modification des vidéos, une seule fois."
              : undefined
          }
        />
        <SocialAccountCard
          platformLabel="Facebook"
          connectUrl="/api/oauth/facebook/start"
          account={facebookAccount}
        />
      </div>
    </div>
  );
}
