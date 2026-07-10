import { Skeleton } from "@/components/ui/skeleton";
import { Card } from "@/components/ui/card";

/** Squelette de la page Connexions : en-tête + 2 cartes de compte (Instagram/TikTok). */
export default function ConnectionsLoading() {
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Skeleton className="h-[19px] w-32" />
        <Skeleton className="h-[13px] w-72" />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <Card key={i} className="gap-0 px-4 py-4">
            <div className="flex items-center justify-between gap-2">
              <Skeleton className="h-5 w-24 rounded-full" />
              <Skeleton className="h-5 w-20 rounded-full" />
            </div>
            <div className="mt-3 flex items-center justify-between gap-4">
              <div className="flex min-w-0 items-center gap-3">
                <Skeleton className="size-8 shrink-0 rounded-full" />
                <div className="min-w-0 space-y-1.5">
                  <Skeleton className="h-3.5 w-28" />
                  <Skeleton className="h-3 w-20" />
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Skeleton className="h-8 w-20" />
                <Skeleton className="h-8 w-24" />
              </div>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
