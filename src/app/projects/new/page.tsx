import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { ProjectCreateForm } from "@/components/project-create-form";

export default async function NewProjectPage() {
  // Service templates are firm structure — admin only (src/lib/permissions.ts).
  await requireAdmin();

  return (
    <div className="mx-auto w-full max-w-2xl px-8 py-8">
      <Link href="/projects" className="text-sm text-ink-muted hover:text-accent">
        ← All projects
      </Link>
      <div className="mt-4">
        <h1 className="text-2xl font-semibold tracking-tight">New project</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Start from scratch with your own project and checklist.
        </p>
      </div>

      <ProjectCreateForm />
    </div>
  );
}
