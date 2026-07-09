import { Skeleton } from "@/components/ui/skeleton";

export default function CalendarLoading() {
  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          <Skeleton className="h-[19px] w-32" />
          <Skeleton className="h-[13px] w-64" />
        </div>
        <div className="flex items-center gap-2">
          <Skeleton className="size-8 rounded-md" />
          <Skeleton className="h-[13.5px] w-20" />
          <Skeleton className="size-8 rounded-md" />
        </div>
      </div>
      <div className="hidden overflow-hidden rounded-lg border border-border bg-card md:block">
        <div className="grid grid-cols-7 border-b border-border">
          {Array.from({ length: 7 }).map((_, i) => (
            <div key={i} className="px-2 py-2">
              <Skeleton className="h-[10px] w-6" />
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {Array.from({ length: 35 }).map((_, i) => (
            <div key={i} className="min-h-24 border-b border-r border-border p-1.5 last:border-r-0">
              <Skeleton className="mb-1 size-6 rounded-lg" />
              {i % 3 === 0 && <Skeleton className="h-4 w-full rounded-full" />}
            </div>
          ))}
        </div>
      </div>
      <div className="space-y-3 md:hidden">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="overflow-hidden rounded-lg border border-border bg-card">
            <div className="border-b border-border px-3.5 py-2.5">
              <Skeleton className="h-4 w-40" />
            </div>
            <div className="space-y-2 p-2.5">
              <Skeleton className="h-10 w-full rounded-md" />
              <Skeleton className="h-10 w-full rounded-md" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
