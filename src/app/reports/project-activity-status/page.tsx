import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { StatusBadge } from "@/components/status-badge";
import { deriveAssignmentStatus, progressLabel } from "@/lib/workflow";
import { formatDueDate } from "@/lib/dates";
import { ReportHeader } from "@/components/report-header";

export default async function ProjectActivityStatusPage() {
  const [projects, assignments, activities, periods] = await Promise.all([
    prisma.project.findMany({ orderBy: { name: "asc" } }),
    prisma.projectClientMap.findMany({ where: { active: true }, include: { client: true } }),
    prisma.clientActivity.findMany(),
    prisma.accountingPeriod.findMany(),
  ]);

  const periodByName = new Map(periods.map((p) => [p.name, p]));

  const groups = projects.map((p) => {
    const rows = assignments
      .filter((a) => a.projectId === p.id)
      .map((a) => {
        const periodActivities = activities.filter(
          (act) =>
            act.clientId === a.clientId &&
            act.projectId === a.projectId &&
            act.periodName === a.currentPeriod
        );
        return {
          clientId: a.clientId,
          clientName: a.client.companyName,
          status: deriveAssignmentStatus(periodActivities),
          progress: progressLabel(periodActivities),
          dueDate: a.currentPeriod ? periodByName.get(a.currentPeriod)?.endDate ?? null : null,
        };
      });
    return { project: p, rows };
  });

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-10">
      <Link href="/" className="no-print text-sm text-ink-muted hover:text-accent">
        ← Back to home
      </Link>
      <ReportHeader
        title="Project Activity Status"
        description="Every service, and where each of its clients currently stands."
        reportKey="project-activity-status"
      />

      <div className="mt-6 flex flex-col gap-6">
        {groups.map(({ project, rows }) => (
          <div key={project.id} className="overflow-hidden rounded-lg border border-line bg-surface">
            <div className="bg-accent-soft px-4 py-2 text-sm font-medium text-ink">
              {project.name}
            </div>
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-line bg-black/[0.02] text-xs uppercase tracking-wide text-ink-muted">
                  <th className="px-4 py-2 font-medium">Client</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">Progress</th>
                  <th className="px-4 py-2 font-medium">Due</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.clientId} className="border-b border-line last:border-0">
                    <td className="px-4 py-2">
                      <Link
                        href={`/clients/${r.clientId}`}
                        className="font-medium text-ink hover:text-accent"
                      >
                        {r.clientName}
                      </Link>
                    </td>
                    <td className="px-4 py-2">
                      <StatusBadge status={r.status} />
                    </td>
                    <td className="tabular px-4 py-2 text-ink-muted">{r.progress}</td>
                    <td className="tabular px-4 py-2 text-ink-muted">{formatDueDate(r.dueDate)}</td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-4 py-6 text-center text-ink-muted">
                      No clients assigned to this service.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </div>
  );
}
