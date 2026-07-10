import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

/** Squelette des Paramètres : en-tête + carte Profil (3 champs) + carte Notifications Telegram. */
export default function SettingsLoading() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-[19px] w-32" />
        <Skeleton className="h-[13px] w-64" />
      </div>

      <Card className="max-w-md gap-0 py-0">
        <CardHeader className="border-b border-border py-0">
          <Skeleton className="my-3 h-4 w-16" />
        </CardHeader>
        <CardContent className="space-y-4 py-3.5">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="space-y-1.5">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-9 w-full rounded-md" />
            </div>
          ))}
          <Skeleton className="h-9 w-28" />
        </CardContent>
      </Card>

      <Card className="max-w-md gap-0 py-0">
        <CardHeader className="border-b border-border py-0">
          <Skeleton className="my-3 h-4 w-48" />
        </CardHeader>
        <CardContent className="space-y-2 py-3.5">
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-4/5" />
        </CardContent>
      </Card>
    </div>
  );
}
