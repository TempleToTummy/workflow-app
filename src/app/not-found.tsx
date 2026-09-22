import { NotFoundState } from "@/components/error-state";

// Serves both notFound() calls that reach the root and any URL the app doesn't
// route at all (see the not-found.js docs). Keep it useful for both: a
// mistyped address and a deleted record arrive here identically.
export default function NotFound() {
  return <NotFoundState />;
}
