import { NotFoundState } from "@/components/error-state";

export default function NotFound() {
  return (
    <NotFoundState
      title="Client not found"
      description="That client isn't on file. It may have been deleted, or the link may be out of date."
      backHref="/clients"
      backLabel="Back to clients"
    />
  );
}
