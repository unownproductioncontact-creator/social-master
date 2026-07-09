import { Skeleton } from "@/components/ui/skeleton";
import { Card } from "@/components/ui/card";

/** Squelette du tableau de bord : en-tête + 3 stats + liste (gauche) + 2 cartes (droite). */
export default function DashboardLoading() {
  return (
    <div className="space-y-4">
      {/* En-tête */}
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          <Skeleton className="h-6 w-52" />
          <Skeleton className="h-4 w-64" />
        </div>
        <div className="flex shrink-0 gap-2">
          <Skeleton className="h-9 w-32" />
          <Skeleton className="h-9 w-36" />
        </div>
      </div>

      {/* 3 cartes de statistiques */}
      <div className="grid gap-3 sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Card key={i} className="gap-0 px-3.5">
            <Skeleton className="h-3.5 w-28" />
            <Skeleton className="mt-2 h-6 w-10" />
            <Skeleton className="mt-2 h-3 w-24" />
          </Card>
        ))}
      </div>

      {/* Liste + colonne de droite */}
      <div className="grid items-start gap-3 lg:grid-cols-[1.45fr_1fr]">
        <Card className="gap-0 py-0">
          <div className="border-b border-border px-[15px] py-3">
            <Skeleton className="h-4 w-40" />
          </div>
          <div className="flex flex-col">
            {Array.from({ length: 5 }).map((_, i) => (
              <div
                key={i}
                className="flex items-center gap-3 border-b border-border px-[15px] py-[11px] last:border-b-0"
              >
                <Skeleton className="size-11 shrink-0 rounded-lg" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-3.5 w-3/4" />
                  <Skeleton className="h-4 w-32" />
                </div>
                <Skeleton className="h-5 w-16 rounded-full" />
              </div>
            ))}
          </div>
        </Card>

        <div className="flex flex-col gap-3">
          <Card className="gap-0 px-[15px] py-[13px]">
            <Skeleton className="mb-3 h-4 w-32" />
            <div className="grid grid-cols-7 gap-1.5">
              {Array.from({ length: 14 }).map((_, i) => (
                <Skeleton key={i} className="aspect-square w-full rounded-lg" />
              ))}
            </div>
          </Card>
          <Card className="gap-0 py-0">
            <div className="border-b border-border px-[15px] py-3">
              <Skeleton className="h-4 w-28" />
            </div>
            {Array.from({ length: 2 }).map((_, i) => (
              <div
                key={i}
                className="flex items-center justify-between border-b border-border px-[15px] py-[11px] last:border-b-0"
              >
                <Skeleton className="h-5 w-40 rounded-full" />
                <Skeleton className="h-5 w-16 rounded-full" />
              </div>
            ))}
          </Card>
        </div>
      </div>
    </div>
  );
}
