import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { deriveAssignmentStatus } from "@/lib/workflow";
import { STATUS_LABEL } from "@/components/status-badge";
import type { ActivityStatus } from "@prisma/client";
import { ReportHeader } from "@/components/report-header";

const STATUSES: ActivityStatus[] = ["NOT_STARTED", "IN_PROGRESS", "AWAITING_REVIEW", "DONE"];

export default async function ProjectSummaryMatrixPage() {
  const [projects, assignments, activities] = await Promise.all([
    prisma.project.findMany({ orderBy: { name: "asc" } }),
    prisma.projectClientMap.findMany({ where: { active: true } }),
    prisma.clientActivity.findMany(),
  ]);

  const rows = projects.map((p) => {
    const projectAssignments = assignments.filter((a) => a.projectId === p.id);
    const counts: Record<ActivityStatus, number> = {
      NOT_STARTED: 0,
      IN_PROGRESS: 0,
      AWAITING_REVIEW: 0,
      DONE: 0,
    };
    for (const a of projectAssignments) {
      const periodActivities = activities.filter(
        (act) =>
          act.clientId === a.clientId &&
          act.projectId === a.projectId &&
          act.periodName === a.currentPeriod
      );
      counts[deriveAssignmentStatus(periodActivities)]++;
    }
    return { project: p, counts, total: projectAssignments.length };
  });

  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-10">
      <Link href="/" className="no-print text-sm text-ink-muted hover:text-accent">
        ← Back to home
      </Link>
      <ReportHeader
        title="Project Summary Matrix"
        description="How many active clients are in each status, per service."
        reportKey="project-summary-matrix"
      />

      <div className="mt-6 overflow-hidden rounded-lg border border-line bg-surface">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-line bg-black/[0.02] text-xs uppercase tracking-wide text-ink-muted">
              <th className="px-4 py-3 font-medium">Project</th>
              {STATUSES.map((s) => (
                <th key={s} className="tabular px-4 py-3 text-right font-medium">
                  {STATUS_LABEL[s]}
                </th>
              ))}
              <th className="tabular px-4 py-3 text-right font-medium">Total</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ project, counts, total }) => (
              <tr key={project.id} className="border-b border-line last:border-0">
                <td className="px-4 py-2 font-medium text-ink">{project.name}</td>
                {STATUSES.map((s) => (
                  <td key={s} className="tabular px-4 py-2 text-right text-ink-muted">
                    {counts[s]}
                  </td>
                ))}
                <td className="tabular px-4 py-2 text-right font-medium text-ink">{total}</td>
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
