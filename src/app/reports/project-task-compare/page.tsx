import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { ReportHeader } from "@/components/report-header";

export default async function ProjectTaskComparePage() {
  const projects = await prisma.project.findMany({
    include: { subtasks: { include: { subTask: true }, orderBy: { sequence: "asc" } } },
    orderBy: { name: "asc" },
  });

  const maxSteps = Math.max(0, ...projects.map((p) => p.subtasks.length));
  const rows = Array.from({ length: maxSteps }, (_, i) => i);

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-10">
      <Link href="/" className="no-print text-sm text-ink-muted hover:text-accent">
        ← Back to home
      </Link>
      <ReportHeader
        title="Project Task Compare"
        description="Every project's ordered checklist, side by side by step position."
        reportKey="project-task-compare"
      />

      <div className="mt-6 overflow-x-auto rounded-lg border border-line bg-surface">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-line bg-black/[0.02] text-xs uppercase tracking-wide text-ink-muted">
              <th className="sticky left-0 bg-black/[0.02] px-4 py-3 font-medium">Step #</th>
              {projects.map((p) => (
                <th key={p.id} className="min-w-[180px] px-4 py-3 font-medium">
                  {p.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((i) => (
              <tr key={i} className="border-b border-line last:border-0">
                <td className="sticky left-0 bg-surface px-4 py-2 text-xs text-ink-muted">
                  {i + 1}
                </td>
                {projects.map((p) => (
                  <td key={p.id} className="px-4 py-2 text-ink-muted">
                    {p.subtasks[i]
                      ? `${p.subtasks[i].sequence}. ${p.subtasks[i].subTask.name}`
                      : ""}
                  </td>
                ))}
              </tr>
            ))}
            {maxSteps === 0 && (
              <tr>
                <td colSpan={projects.length + 1} className="px-4 py-10 text-center text-ink-muted">
                  No checklists defined yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
