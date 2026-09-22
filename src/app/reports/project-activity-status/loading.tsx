import { ReportSkeleton } from "@/components/skeleton";

// This report reads and groups a large slice of the activity table, so without
// a fallback the navigation appears to hang. The skeleton's shape matches the
// finished table, so the layout doesn't jump when the data arrives.
export default function Loading() {
  return <ReportSkeleton rows={12} columns={4} />;
}
