import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";

/** Squelette du détail/édition d'un post : en-tête (statut) + formulaire + panneau de programmation. */
export default function EditPostLoading() {
  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="space-y-2">
          <Skeleton className="h-[19px] w-48" />
          <Skeleton className="h-5 w-32 rounded-full" />
        </div>
        <Skeleton className="h-9 w-28 shrink-0" />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-5">
          <div className="space-y-1.5">
            <Skeleton className="h-3 w-14" />
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="aspect-square w-full rounded-lg" />
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-24 w-full rounded-md" />
          </div>

          <div className="space-y-2.5">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-5 w-40 rounded-full" />
            <Skeleton className="h-5 w-32 rounded-full" />
          </div>

          <Skeleton className="h-9 w-48" />
        </div>

        <Card className="mx-auto w-full max-w-xs gap-0 overflow-hidden py-0">
          <Skeleton className="aspect-9/16 w-full" />
          <CardContent className="space-y-2 py-3">
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-2/3" />
          </CardContent>
        </Card>
      </div>

      <div className="max-w-xl">
        <Card className="gap-0 py-0">
          <div className="border-b border-border px-[15px] py-3">
            <Skeleton className="h-4 w-32" />
          </div>
          <CardContent className="space-y-3 py-3.5">
            <Skeleton className="h-3.5 w-56" />
            <div className="space-y-2">
              {Array.from({ length: 2 }).map((_, i) => (
                <div key={i} className="flex items-center justify-between gap-2">
                  <Skeleton className="h-5 w-24 rounded-full" />
                  <Skeleton className="h-5 w-28 rounded-full" />
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
