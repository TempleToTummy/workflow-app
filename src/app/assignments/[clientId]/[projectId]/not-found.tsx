import { NotFoundState } from "@/components/error-state";

export default function NotFound() {
  return (
    <NotFoundState
      title="Engagement not found"
      description="This client isn't assigned to that service, or the accounting period in the link doesn't exist for them."
      backHref="/"
      backLabel="Back to dashboard"
    />
  );
}
