import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { ProjectForm } from "@/components/project-form";

export default async function EditProjectPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: { recurring: true },
  });

  if (!project) notFound();

  return (
    <div className="mx-auto w-full max-w-3xl px-8 py-8">
      <Link href="/admin/projects" className="text-sm text-ink-muted hover:text-accent">
        ← Back to projects
      </Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">Edit Project</h1>

      <ProjectForm
        mode="edit"
        project={{
          id: project.id,
          name: project.name,
          description: project.description,
          recurring: project.recurring.type,
          dueOffsetDays: project.dueOffsetDays,
        }}
      />
    </div>
  );
}
