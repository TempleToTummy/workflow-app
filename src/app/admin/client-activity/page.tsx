import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { FilterBar } from "@/components/filter-bar";
import { AdminActivityRow } from "@/components/admin-activity-row";
import type { ActivityStatus } from "@prisma/client";

export default async function AdminClientActivityPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | undefined }>;
}) {
  const params = await searchParams;
  const statusFilter = params.status as ActivityStatus | undefined;
  const clientFilter = params.clientId;
  const assigneeFilter = params.assigneeId;

  const [activities, clients, employees] = await Promise.all([
    prisma.clientActivity.findMany({
      include: { client: true, project: true, subTask: true },
      orderBy: [{ clientId: "asc" }, { projectId: "asc" }, { periodName: "desc" }, { taskSeqNo: "asc" }],
    }),
    prisma.client.findMany({ orderBy: { companyName: "asc" } }),
    prisma.employee.findMany({ orderBy: { firstName: "asc" } }),
  ]);

  const rows = activities
    .filter((a) => !statusFilter || a.status === statusFilter)
    .filter((a) => !clientFilter || a.clientId === clientFilter)
    .filter((a) => !assigneeFilter || a.assigneeId === assigneeFilter);

  const employeeOptions = employees.map((e) => ({
    id: e.id,
    name: `${e.firstName} ${e.lastName}`,
  }));

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-10">
      <Link href="/" className="text-sm text-ink-muted hover:text-accent">
        ← Back to home
      </Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">Admin Client Activity</h1>
      <p className="mt-1 text-sm text-ink-muted">
        Every task row across every client, project, and period, editable directly.
      </p>

      <div className="my-4">
        <FilterBar
          clients={clients.map((c) => ({ value: c.id, label: c.companyName }))}
          employees={employeeOptions.map((e) => ({ value: e.id, label: e.name }))}
        />
      </div>

      <div className="overflow-x-auto rounded-lg border border-line bg-surface">
        <table className="w-full min-w-[900px] text-left text-sm">
          <thead>
            <tr className="border-b border-line bg-black/[0.02] text-xs uppercase tracking-wide text-ink-muted">
              <th className="px-4 py-3 font-medium">Client</th>
              <th className="px-4 py-3 font-medium">Project</th>
              <th className="px-4 py-3 font-medium">Period</th>
              <th className="px-4 py-3 font-medium">Task</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Assignee</th>
              <th className="px-4 py-3 font-medium">Notes</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.id} className="border-b border-line last:border-0">
                <td className="px-4 py-2">
                  <Link
                    href={`/clients/${a.clientId}`}
                    className="font-medium text-ink hover:text-accent"
                  >
                    {a.client.companyName}
                  </Link>
                </td>
                <td className="px-4 py-2 text-ink-muted">{a.project.name}</td>
                <td className="px-4 py-2 text-ink-muted">{a.periodName}</td>
                <td className="px-4 py-2 text-ink-muted">
                  <span className="tabular mr-1 text-xs">{a.taskSeqNo}</span>
                  {a.subTask.name}
                </td>
                <AdminActivityRow
                  activityId={a.id}
                  status={a.status}
                  notes={a.notes}
                  assigneeId={a.assigneeId}
                  employees={employeeOptions}
                />
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-ink-muted">
                  No activity matches these filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
