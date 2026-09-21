import Link from "next/link";
import { ProjectForm } from "@/components/project-form";

export default function NewProjectPage() {
  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-10">
      <Link href="/admin/projects" className="text-sm text-ink-muted hover:text-accent">
        ← Back to projects
      </Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">New Project</h1>

      <ProjectForm mode="create" />
    </div>
  );
}
