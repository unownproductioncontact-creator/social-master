import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";

/** Squelette de la publication en masse : en-tête + zone d'ajout + cartes vidéo. */
export default function BulkComposerLoading() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-[19px] w-56" />
        <Skeleton className="h-[13px] w-[28rem] max-w-full" />
      </div>

      <Card className="gap-0 py-0">
        <div className="border-b border-border px-[15px] py-3">
          <Skeleton className="h-4 w-36" />
        </div>
        <CardContent className="py-3.5">
          <Skeleton className="h-28 w-full rounded-lg" />
        </CardContent>
      </Card>

      <div className="space-y-4">
        {Array.from({ length: 2 }).map((_, i) => (
          <Card key={i}>
            <CardContent className="space-y-4">
              <div className="flex items-start gap-3">
                <Skeleton className="size-16 shrink-0 rounded-lg" />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <Skeleton className="h-3.5 w-2/5" />
                  <Skeleton className="h-3 w-16" />
                </div>
              </div>
              <Skeleton className="h-16 w-full rounded-md" />
              <div className="flex flex-wrap gap-2">
                <Skeleton className="h-5 w-24 rounded-full" />
                <Skeleton className="h-5 w-20 rounded-full" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Skeleton className="h-9 w-56" />
    </div>
  );
}
