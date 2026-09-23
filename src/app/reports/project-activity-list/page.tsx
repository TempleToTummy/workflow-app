import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { StatusBadge } from "@/components/status-badge";
import { ReportHeader } from "@/components/report-header";

export default async function ProjectActivityListPage() {
  const activities = await prisma.clientActivity.findMany({
    where: { client: { archivedAt: null } },
    include: { client: true, project: true, subTask: true },
    orderBy: [
      { client: { companyName: "asc" } },
      { periodName: "desc" },
      { taskSeqNo: "asc" },
    ],
  });

  const groups = new Map<
    string,
    { clientName: string; periodName: string; rows: typeof activities }
  >();
  for (const a of activities) {
    const key = `${a.clientId}__${a.periodName}`;
    if (!groups.has(key)) {
      groups.set(key, { clientName: a.client.companyName, periodName: a.periodName, rows: [] });
    }
    groups.get(key)!.rows.push(a);
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-10">
      <Link href="/" className="no-print text-sm text-ink-muted hover:text-accent">
        ← Back to home
      </Link>
      <ReportHeader
        title="Project Activity List"
        description="Every task row on file, grouped by client and period."
        reportKey="project-activity-list"
      />

      <div className="mt-6 flex flex-col gap-6">
        {[...groups.values()].map((g) => (
          <div key={`${g.clientName}-${g.periodName}`} className="overflow-hidden rounded-lg border border-line bg-surface">
            <div className="bg-accent-soft px-4 py-2 text-sm font-medium text-ink">
              Client: {g.clientName} · Period: {g.periodName}
            </div>
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-line bg-black/[0.02] text-xs uppercase tracking-wide text-ink-muted">
                  <th className="px-4 py-2 font-medium">Project</th>
                  <th className="px-4 py-2 font-medium">Task</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">Task Seq No</th>
                  <th className="px-4 py-2 font-medium">Notes</th>
                </tr>
              </thead>
              <tbody>
                {g.rows.map((a) => (
                  <tr key={a.id} className="border-b border-line last:border-0">
                    <td className="px-4 py-2 text-ink">{a.project.name}</td>
                    <td className="px-4 py-2 text-ink-muted">{a.subTask.name}</td>
                    <td className="px-4 py-2">
                      <StatusBadge status={a.status} />
                    </td>
                    <td className="tabular px-4 py-2 text-ink-muted">{a.taskSeqNo}</td>
                    <td className="px-4 py-2 text-ink-muted">{a.notes ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
        {groups.size === 0 && (
          <p className="rounded-lg border border-dashed border-line px-4 py-10 text-center text-ink-muted">
            No activity on file yet.
          </p>
        )}
      </div>
    </div>
  );
}
