import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { ProjectTaskMapEditor } from "@/components/project-task-map-editor";

export default async function ProjectsTaskMapPage() {
  const [projects, subtasks] = await Promise.all([
    prisma.project.findMany({
      include: { subtasks: { include: { subTask: true }, orderBy: { sequence: "asc" } } },
      orderBy: { name: "asc" },
    }),
    prisma.projectSubTask.findMany({ orderBy: { name: "asc" } }),
  ]);

  return (
    <div className="mx-auto w-full max-w-6xl px-8 py-8">
      <Link href="/" className="text-sm text-ink-muted hover:text-accent">
        ← Back to home
      </Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">Projects Task Map</h1>
      <p className="mt-1 text-sm text-ink-muted">
        Each project&apos;s ordered checklist. Add steps from the master list on{" "}
        <Link href="/admin/projects-task" className="text-accent hover:underline">
          Projects Task
        </Link>{" "}
        first if the one you need doesn&apos;t exist yet.
      </p>

      <div className="mt-6 flex flex-col gap-5">
        {projects.map((p) => (
          <ProjectTaskMapEditor
            key={p.id}
            projectId={p.id}
            projectName={p.name}
            steps={p.subtasks.map((tm) => ({
              subTaskId: tm.subTaskId,
              name: tm.subTask.name,
              sequence: tm.sequence,
            }))}
            availableSubtasks={subtasks}
          />
        ))}
      </div>
    </div>
  );
}
