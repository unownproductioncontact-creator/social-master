import { getCurrentUser } from "@/lib/dal";
import { db } from "@/lib/db";
import { notFound } from "next/navigation";
import { ProfileForm } from "@/components/settings/profile-form";
import { MediaRetentionForm } from "@/components/settings/media-retention-form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/layout/page-header";

export default async function SettingsPage() {
  const user = await getCurrentUser();
  if (!user) notFound();

  const prefs = await db.user.findUnique({
    where: { id: user.id },
    select: { mediaRetentionDays: true },
  });

  return (
    <div className="space-y-6">
      <PageHeader title="Paramètres" description="Profil, fuseau horaire et notifications." />

      <Card className="max-w-md gap-0 py-0">
        <CardHeader className="border-b border-border py-0">
          <CardTitle className="px-0.5 py-3 text-[13.5px]">Profil</CardTitle>
        </CardHeader>
        <CardContent className="py-3.5">
          <ProfileForm name={user.name} email={user.email} timezone={user.timezone} />
        </CardContent>
      </Card>

      <Card className="max-w-md gap-0 py-0">
        <CardHeader className="border-b border-border py-0">
          <CardTitle className="px-0.5 py-3 text-[13.5px]">Médiathèque</CardTitle>
        </CardHeader>
        <CardContent className="py-3.5">
          <MediaRetentionForm mediaRetentionDays={prefs?.mediaRetentionDays ?? null} />
        </CardContent>
      </Card>

      <Card className="max-w-md gap-0 py-0">
        <CardHeader className="border-b border-border py-0">
          <CardTitle className="px-0.5 py-3 text-[13.5px]">Notifications Telegram</CardTitle>
        </CardHeader>
        <CardContent className="py-3.5">
          <CardDescription className="text-[12.5px]">
            Les alertes d’échec de publication sont envoyées via un bot Telegram configuré au niveau du serveur
            (variables d’environnement <code>TELEGRAM_BOT_TOKEN</code> et <code>TELEGRAM_CHAT_ID</code>).
          </CardDescription>
        </CardContent>
      </Card>
    </div>
  );
}
