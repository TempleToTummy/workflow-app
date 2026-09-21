import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { ProjectSubTaskManager } from "@/components/project-subtask-manager";

export default async function ProjectsTaskPage() {
  const subtasks = await prisma.projectSubTask.findMany({ orderBy: { name: "asc" } });

  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-10">
      <Link href="/" className="text-sm text-ink-muted hover:text-accent">
        ← Back to home
      </Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">Projects Task</h1>
      <p className="mt-1 text-sm text-ink-muted">
        The master list of checklist steps. Attach a step to a project&apos;s ordered checklist on
        the{" "}
        <Link href="/admin/projects-task-map" className="text-accent hover:underline">
          Projects Task Map
        </Link>{" "}
        page.
      </p>

      <div className="mt-6">
        <ProjectSubTaskManager subtasks={subtasks} />
      </div>
    </div>
  );
}
