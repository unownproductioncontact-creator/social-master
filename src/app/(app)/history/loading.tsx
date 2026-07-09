import { Skeleton } from "@/components/ui/skeleton";
import { Card } from "@/components/ui/card";

export default function HistoryLoading() {
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-4 w-72" />
      </div>
      <Card className="gap-0 py-0">
        <div className="flex flex-col">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="flex items-center gap-3 border-b border-border px-[15px] py-[11px] last:border-b-0"
            >
              <Skeleton className="size-11 shrink-0 rounded-lg" />
              <div className="min-w-0 flex-1 space-y-1.5">
                <Skeleton className="h-3.5 w-2/5" />
                <Skeleton className="h-3 w-1/3" />
              </div>
              <Skeleton className="h-5 w-20 shrink-0 rounded-full" />
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
