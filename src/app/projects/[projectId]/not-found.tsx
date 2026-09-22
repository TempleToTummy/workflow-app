import { NotFoundState } from "@/components/error-state";

export default function NotFound() {
  return (
    <NotFoundState
      title="Project not found"
      description="That service template isn't on file. It may have been deleted, or the link may be out of date."
      backHref="/projects"
      backLabel="Back to projects"
    />
  );
}
