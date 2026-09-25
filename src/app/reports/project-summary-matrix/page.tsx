import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { currentPeriodWork } from "@/lib/work-summary";
import { deriveAssignmentStatus } from "@/lib/workflow";
import { STATUS_LABEL, STATUS_CLASSES } from "@/components/status-badge";
import type { ActivityStatus } from "@prisma/client";
import { ReportHeader } from "@/components/report-header";

const STATUSES: ActivityStatus[] = ["NOT_STARTED", "IN_PROGRESS", "AWAITING_REVIEW", "DONE"];

export default async function ProjectSummaryMatrixPage() {
  const [projects, assignments] = await Promise.all([
    prisma.project.findMany({ orderBy: { name: "asc" } }),
    prisma.projectClientMap.findMany({ where: { active: true, client: { archivedAt: null } } }),
  ]);
  // Each engagement's current-period rows, read once and indexed (src/lib/work-summary.ts).
  const workFor = await currentPeriodWork(assignments);

  const rows = projects.map((p) => {
    const projectAssignments = assignments.filter((a) => a.projectId === p.id);
    const counts: Record<ActivityStatus, number> = {
      NOT_STARTED: 0,
      IN_PROGRESS: 0,
      AWAITING_REVIEW: 0,
      DONE: 0,
    };
    for (const a of projectAssignments) {
      const periodActivities = workFor(a);
      counts[deriveAssignmentStatus(periodActivities)]++;
    }
    return { project: p, counts, total: projectAssignments.length };
  });

  return (
    <div className="mx-auto w-full max-w-6xl px-8 py-8">
      <Link href="/" className="no-print text-sm text-ink-muted hover:text-accent">
        ← Back to home
      </Link>
      <ReportHeader
        title="Project Summary Matrix"
        description="How many active clients are in each status, per service."
        reportKey="project-summary-matrix"
      />

      <div className="mt-6 overflow-x-auto rounded-lg border border-line bg-surface">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-line bg-black/[0.02] text-xs uppercase tracking-wide text-ink-muted">
              <th className="px-4 py-3 font-medium">Project</th>
              {STATUSES.map((s) => (
                <th key={s} className="w-32 px-4 py-3 text-center font-medium">
                  {STATUS_LABEL[s]}
                </th>
              ))}
              <th className="w-24 px-4 py-3 text-center font-medium">Total</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ project, counts, total }) => (
              <tr key={project.id} className="border-b border-line last:border-0 hover:bg-black/[0.015]">
                <td className={`px-4 py-2.5 font-medium ${total > 0 ? "text-ink" : "text-ink-muted"}`}>
                  {project.name}
                </td>
                {STATUSES.map((s) => (
                  <td key={s} className="px-4 py-2.5 text-center">
                    {/* A zero is the common case, so it recedes; a real count
                        gets its status colour, centred in the column. */}
                    {counts[s] > 0 ? (
                      <span className={`count-pill status-badge h-6 min-w-6 px-2 text-xs ${STATUS_CLASSES[s]}`}>
                        {counts[s]}
                      </span>
                    ) : (
                      <span className="tabular text-ink-muted/40">0</span>
                    )}
                  </td>
                ))}
                <td
                  className={`tabular px-4 py-2.5 text-center font-semibold ${
                    total > 0 ? "text-ink" : "text-ink-muted/40"
                  }`}
                >
                  {total}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={STATUSES.length + 2} className="px-4 py-10 text-center text-ink-muted">
                  No projects yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
