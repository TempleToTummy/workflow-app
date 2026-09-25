// Loading skeletons for the loading.tsx files.
//
// A server component by default (no "use client"): these render no interaction
// and pulling React's client runtime in for a grey rectangle would be waste.
//
// The reports are the pages that needed this. Several of them read every
// ClientActivity row in the database and group it in memory — Project Activity
// List, the two matrices, Project Task Compare — so on a real dataset there is
// a visible pause with no feedback at all before this existed. The shape of
// each skeleton deliberately matches the page it stands in for, so the layout
// doesn't jump when the real content swaps in.

// `animate-pulse` on a `bg-black/[0.06]` block reads as "loading" on the cream
// ground without needing a spinner asset.
const BLOCK = "animate-pulse rounded bg-black/[0.06]";

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`${BLOCK} ${className}`} aria-hidden />;
}

// A page heading and its subtitle. Every report and operational page starts
// with this pair, so the top of the screen settles immediately.
export function PageHeaderSkeleton({ wide = false }: { wide?: boolean }) {
  return (
    <div className="flex flex-col gap-2">
      <Skeleton className="h-4 w-28" />
      <Skeleton className={`h-7 ${wide ? "w-80" : "w-56"}`} />
      <Skeleton className="h-4 w-72" />
    </div>
  );
}

export function TableSkeleton({
  rows = 8,
  columns = 5,
}: {
  rows?: number;
  columns?: number;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-surface">
      <div className="flex gap-4 border-b border-line bg-black/[0.02] px-4 py-2.5">
        {Array.from({ length: columns }).map((_, i) => (
          <Skeleton key={i} className="h-3 flex-1" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex gap-4 border-b border-line px-4 py-3 last:border-0">
          {Array.from({ length: columns }).map((_, c) => (
            <Skeleton
              key={c}
              // Varying the widths keeps it from looking like a broken grid.
              className={`h-3.5 flex-1 ${c === 0 ? "max-w-[28%]" : ""}`}
            />
          ))}
        </div>
      ))}
      <span className="sr-only">Loading…</span>
    </div>
  );
}

export function CardsSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="rounded-lg border border-line bg-surface p-4">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="mt-3 h-7 w-12" />
        </div>
      ))}
    </div>
  );
}

// The standard report shell: heading, then a table. One import covers most of
// the loading.tsx files.
export function ReportSkeleton({
  rows = 10,
  columns = 5,
}: {
  rows?: number;
  columns?: number;
}) {
  return (
    <div className="mx-auto w-full max-w-6xl px-8 py-8">
      <PageHeaderSkeleton />
      <div className="mt-6">
        <TableSkeleton rows={rows} columns={columns} />
      </div>
    </div>
  );
}
