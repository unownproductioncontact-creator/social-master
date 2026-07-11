import { verifySession } from "@/lib/dal";
import { db } from "@/lib/db";
import { SocialAccountCard } from "@/components/connections/social-account-card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { PageHeader } from "@/components/layout/page-header";
import { CheckCircle2, AlertTriangle } from "lucide-react";

export default async function ConnectionsPage({
  searchParams,
}: {
  searchParams: Promise<{ instagram?: string; tiktok?: string; youtube?: string; detail?: string }>;
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

  const feedback = params.instagram ?? params.tiktok ?? params.youtube;
  const feedbackIsError = feedback === "error";

  return (
    <div className="space-y-4">
      <PageHeader title="Connexions" description="Connectez vos comptes Instagram, TikTok et YouTube." />

      {feedback && (
        <Alert variant={feedbackIsError ? "destructive" : "default"}>
          {feedbackIsError ? <AlertTriangle className="size-4" /> : <CheckCircle2 className="size-4" />}
          <AlertTitle className="text-[13.5px] font-semibold">
            {feedbackIsError ? "Échec de connexion" : "Compte connecté"}
          </AlertTitle>
          {params.detail && <AlertDescription className="text-[12.5px]">{params.detail}</AlertDescription>}
        </Alert>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <SocialAccountCard
          platformLabel="Instagram"
          connectUrl="/api/oauth/instagram/start"
          account={instagramAccount}
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
        />
      </div>
    </div>
  );
}
