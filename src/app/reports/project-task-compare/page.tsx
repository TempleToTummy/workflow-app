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
    <div className="mx-auto w-full max-w-6xl px-8 py-8">
      <Link href="/" className="no-print text-sm text-ink-muted hover:text-accent">
        ← Back to home
      </Link>
      <ReportHeader
        title="Project Task Compare"
        description="Every project's ordered checklist, side by side by step position."
        reportKey="project-task-compare"
      />

      {/* Scrolls inside the card on both axes, capped at the viewport height,
          so the horizontal scrollbar stays on screen and the project names
          stay visible while reading down a long checklist. */}
      <div className="mt-6 max-h-[calc(100vh-12rem)] overflow-auto rounded-lg border border-line bg-surface">
        <table className="w-full border-separate border-spacing-0 text-left text-sm">
          <thead className="sticky top-0 z-[2]">
            <tr className="bg-[#faf7f0] text-[11px] uppercase tracking-wide text-ink-muted">
              <th className="matrix-sticky w-14 border-b border-line px-3 py-3 text-center align-bottom font-medium">
                Step
              </th>
              {projects.map((p) => (
                <th
                  key={p.id}
                  className="w-52 min-w-52 border-b border-line px-4 py-3 align-bottom font-medium leading-snug"
                >
                  {p.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((i) => (
              <tr key={i} className="group">
                <td className="matrix-sticky tabular border-b border-line px-3 py-2.5 text-center align-top text-xs text-ink-muted group-last:border-b-0">
                  {i + 1}
                </td>
                {projects.map((p) => {
                  const step = p.subtasks[i];
                  return (
                    <td
                      key={p.id}
                      className="border-b border-line px-4 py-2.5 align-top group-last:border-b-0 group-hover:bg-black/[0.015]"
                    >
                      {step && (
                        <span className="flex gap-2">
                          <span className="tabular w-7 shrink-0 text-right text-xs leading-5 text-ink-muted">
                            {step.sequence}
                          </span>
                          <span className="text-ink">{step.subTask.name}</span>
                        </span>
                      )}
                    </td>
                  );
                })}
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
