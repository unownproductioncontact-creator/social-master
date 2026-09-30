import { redirect } from "next/navigation";
import { BrandMark } from "@/components/layout/brand-mark";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getCurrentUser } from "@/lib/dal";
import { buildRedirect } from "@/lib/mcp/oauth-core";
import { validateAuthorizeRequest, type AuthorizeParams } from "@/lib/mcp/authorize-request";
import { approveMcpAuthorization, denyMcpAuthorization } from "@/lib/actions/mcp-oauth";

export const dynamic = "force-dynamic";

const CAPABILITIES = [
  "Consulter votre médiathèque, vos publications, l'historique et les échecs",
  "Préparer et modifier des brouillons (légende, hashtags, médias, plateformes)",
  "Programmer, reprogrammer ou annuler une programmation",
  "Publier immédiatement sur Instagram et YouTube, et envoyer des brouillons TikTok",
];

/**
 * Page de consentement du connecteur Claude (OAuth, CLAUDE.md §29). L'utilisateur doit être connecté à
 * Social Master (le proxy redirige vers /login?next=… sinon) et accepter explicitement.
 */
export default async function AuthorizePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const raw = await searchParams;
  const pick = (key: keyof AuthorizeParams) => (typeof raw[key] === "string" ? (raw[key] as string) : undefined);
  const params: AuthorizeParams = {
    response_type: pick("response_type"),
    client_id: pick("client_id"),
    redirect_uri: pick("redirect_uri"),
    code_challenge: pick("code_challenge"),
    code_challenge_method: pick("code_challenge_method"),
    state: pick("state"),
  };

  const user = await getCurrentUser();
  const v = await validateAuthorizeRequest(params);
  if (!v.ok && !("fatal" in v)) {
    redirect(buildRedirect(v.redirectUri, { error: v.redirectError, state: v.state }));
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-background px-4 py-10">
      <BrandMark />
      <div className="w-full max-w-[440px]">
        <Card>
          {!v.ok ? (
            <>
              <CardHeader>
                <CardTitle className="text-[19px] tracking-[-0.015em]">Autorisation impossible</CardTitle>
                <CardDescription className="text-[13px]">{v.fatal}</CardDescription>
              </CardHeader>
            </>
          ) : (
            <>
              <CardHeader>
                <CardTitle className="text-[19px] tracking-[-0.015em]">
                  Autoriser « {v.clientName} » ?
                </CardTitle>
                <CardDescription className="text-[13px]">
                  Cette application demande un accès complet à votre compte Social Master
                  {user?.email ? ` (${user.email})` : ""}.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <ul className="list-disc space-y-1.5 pl-5 text-[13px] text-foreground">
                  {CAPABILITIES.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
                <p className="text-[12px] text-muted-foreground">
                  Claude vous demande confirmation avant chaque action qui publie ou programme. Vous pouvez
                  révoquer cet accès à tout moment dans Paramètres.
                </p>
                <div className="flex gap-2">
                  <form action={denyMcpAuthorization} className="flex-1">
                    <HiddenParams params={params} />
                    <Button type="submit" variant="outline" className="w-full">
                      Refuser
                    </Button>
                  </form>
                  <form action={approveMcpAuthorization} className="flex-1">
                    <HiddenParams params={params} />
                    <Button type="submit" className="w-full">
                      Autoriser
                    </Button>
                  </form>
                </div>
              </CardContent>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}

function HiddenParams({ params }: { params: AuthorizeParams }) {
  return (
    <>
      {Object.entries(params).map(([key, value]) =>
        value ? <input key={key} type="hidden" name={key} value={value} /> : null
      )}
    </>
  );
}
