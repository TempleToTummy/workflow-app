import { PageHeaderSkeleton, TableSkeleton } from "@/components/skeleton";

export default function Loading() {
  return (
    <div className="mx-auto w-full max-w-6xl px-8 py-8">
      <PageHeaderSkeleton />
      <div className="mt-6">
        <TableSkeleton rows={8} columns={5} />
      </div>
    </div>
  );
}
