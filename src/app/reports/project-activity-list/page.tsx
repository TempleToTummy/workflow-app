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
    <div className="mx-auto w-full max-w-6xl px-8 py-8">
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
            <div className="flex items-center gap-2 border-b border-line bg-accent-soft px-4 py-2.5 text-sm">
              <span className="font-semibold text-ink">{g.clientName}</span>
              <span className="count-pill tabular bg-accent/10 text-accent">{g.periodName}</span>
            </div>
            {/* Fixed layout with set column widths, so every group's table
                lines up with the one above it instead of each sizing its
                columns to its own contents. */}
            <table className="w-full table-fixed text-left text-sm">
              <colgroup>
                <col className="w-16" />
                <col className="w-40" />
                <col />
                <col className="w-36" />
                <col className="w-1/4" />
              </colgroup>
              <thead>
                <tr className="border-b border-line bg-black/[0.02] text-xs uppercase tracking-wide text-ink-muted">
                  <th className="px-4 py-2 text-center font-medium">Seq</th>
                  <th className="px-4 py-2 font-medium">Project</th>
                  <th className="px-4 py-2 font-medium">Task</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">Notes</th>
                </tr>
              </thead>
              <tbody>
                {g.rows.map((a) => (
                  <tr key={a.id} className="border-b border-line last:border-0 hover:bg-black/[0.015]">
                    <td className="tabular px-4 py-2 text-center text-ink-muted">{a.taskSeqNo}</td>
                    <td className="truncate px-4 py-2 text-ink">{a.project.name}</td>
                    <td className="px-4 py-2 text-ink-muted">{a.subTask.name}</td>
                    <td className="px-4 py-2">
                      <StatusBadge status={a.status} />
                    </td>
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
