"use client";

import { ErrorState } from "@/components/error-state";

// Scoped so a failure in the admin page doesn't take the whole app's shell with
// it — the sidebar and the rest of the navigation stay usable.
export default function AdminError({
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
      title="Couldn't load this admin page"
      backHref="/admin/projects"
      backLabel="Back to Admin"
    />
  );
}
