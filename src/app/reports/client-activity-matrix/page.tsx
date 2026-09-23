import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { StatusBadge } from "@/components/status-badge";
import { deriveAssignmentStatus } from "@/lib/workflow";
import { ReportHeader } from "@/components/report-header";

export default async function ClientActivityMatrixPage() {
  const [clients, projects, assignments, activities] = await Promise.all([
    prisma.client.findMany({ where: { archivedAt: null }, orderBy: { companyName: "asc" } }),
    prisma.project.findMany({ orderBy: { name: "asc" } }),
    prisma.projectClientMap.findMany({ where: { active: true, client: { archivedAt: null } } }),
    prisma.clientActivity.findMany({ where: { client: { archivedAt: null } } }),
  ]);

  const assignmentByPair = new Map(
    assignments.map((a) => [`${a.clientId}__${a.projectId}`, a])
  );

  function statusFor(clientId: string, projectId: string) {
    const assignment = assignmentByPair.get(`${clientId}__${projectId}`);
    if (!assignment) return null;
    const rows = activities.filter(
      (act) =>
        act.clientId === clientId &&
        act.projectId === projectId &&
        act.periodName === assignment.currentPeriod
    );
    return deriveAssignmentStatus(rows);
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-10">
      <Link href="/" className="no-print text-sm text-ink-muted hover:text-accent">
        ← Back to home
      </Link>
      <ReportHeader
        title="Client Activity Matrix"
        description="Every client's current status across every service, at a glance."
        reportKey="client-activity-matrix"
      />

      <div className="mt-6 overflow-x-auto rounded-lg border border-line bg-surface">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-line bg-black/[0.02] text-xs uppercase tracking-wide text-ink-muted">
              <th className="sticky left-0 bg-black/[0.02] px-4 py-3 font-medium">Client</th>
              {projects.map((p) => (
                <th key={p.id} className="min-w-[140px] px-4 py-3 font-medium">
                  {p.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {clients.map((c) => (
              <tr key={c.id} className="border-b border-line last:border-0 hover:bg-black/[0.015]">
                <td className="sticky left-0 bg-surface px-4 py-2">
                  <Link href={`/clients/${c.id}`} className="font-medium text-ink hover:text-accent">
                    {c.companyName}
                  </Link>
                </td>
                {projects.map((p) => {
                  const status = statusFor(c.id, p.id);
                  return (
                    <td key={p.id} className="px-4 py-2">
                      {status ? <StatusBadge status={status} /> : <span className="text-ink-muted">—</span>}
                    </td>
                  );
                })}
              </tr>
            ))}
            {clients.length === 0 && (
              <tr>
                <td colSpan={projects.length + 1} className="px-4 py-10 text-center text-ink-muted">
                  No clients yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
