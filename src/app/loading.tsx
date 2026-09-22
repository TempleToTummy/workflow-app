import { CardsSkeleton, PageHeaderSkeleton, TableSkeleton } from "@/components/skeleton";

// The dashboard awaits the lazy work-generation catch-up (ensurePeriodsCurrent)
// before it renders, which on a cold start is the slowest thing in the app. The
// due cards and the table are sketched in the same arrangement they'll appear.
export default function Loading() {
  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-10">
      <PageHeaderSkeleton />
      <div className="mt-6">
        <CardsSkeleton />
      </div>
      <div className="mt-6">
        <TableSkeleton rows={10} columns={6} />
      </div>
    </div>
  );
}
