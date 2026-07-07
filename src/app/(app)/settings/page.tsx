import { getCurrentUser } from "@/lib/dal";
import { notFound } from "next/navigation";
import { ProfileForm } from "@/components/settings/profile-form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default async function SettingsPage() {
  const user = await getCurrentUser();
  if (!user) notFound();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Paramètres</h1>
        <p className="text-muted-foreground">Profil, fuseau horaire et notifications.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Profil</CardTitle>
        </CardHeader>
        <CardContent>
          <ProfileForm name={user.name} email={user.email} timezone={user.timezone} />
        </CardContent>
      </Card>

      <Card className="max-w-md">
        <CardHeader>
          <CardTitle className="text-base">Notifications Telegram</CardTitle>
          <CardDescription>
            Les alertes d'échec de publication sont envoyées via un bot Telegram configuré au niveau du serveur
            (variables d'environnement <code>TELEGRAM_BOT_TOKEN</code> et <code>TELEGRAM_CHAT_ID</code>).
          </CardDescription>
        </CardHeader>
      </Card>
    </div>
  );
}
