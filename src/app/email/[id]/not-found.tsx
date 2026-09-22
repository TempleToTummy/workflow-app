import { NotFoundState } from "@/components/error-state";

export default function NotFound() {
  return (
    <NotFoundState
      title="Message not found"
      description="That message isn't on file, or it belongs to an engagement you don't work on."
      backHref="/email"
      backLabel="Back to email"
    />
  );
}
