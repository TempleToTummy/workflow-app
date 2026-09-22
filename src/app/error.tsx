"use client";

import { ErrorState } from "@/components/error-state";

// The app-wide error boundary. Catches anything thrown below the root layout
// that a nearer error.tsx didn't. It renders INSIDE the root layout, so the
// sidebar stays put and the user can navigate away instead of being stranded.
//
// `retry` is this Next version's prop (older ones passed `reset`) — see the
// note in src/components/error-state.tsx.
export default function AppError({
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
      title="Something went wrong"
      description="This page couldn't be loaded. Your work hasn't been lost — try again, or head back to the dashboard."
    />
  );
}
