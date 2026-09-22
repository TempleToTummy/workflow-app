"use client";

import { ErrorState } from "@/components/error-state";

// Scoped so a failure in the workload view doesn't take the whole app's shell with
// it — the sidebar and the rest of the navigation stay usable.
export default function WorkloadError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <ErrorState
      error={error}
      retry={retry}
      title="Couldn't load the workload view"
      backHref="/"
      backLabel="Back to dashboard"
    />
  );
}
