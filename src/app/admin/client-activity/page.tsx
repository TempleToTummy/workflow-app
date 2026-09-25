import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { FilterBar } from "@/components/filter-bar";
import { AdminActivityRow } from "@/components/admin-activity-row";
import { Pager, PAGE_SIZE, pageFromParams } from "@/components/pager";
import type { ActivityStatus, Prisma } from "@prisma/client";

export default async function AdminClientActivityPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | undefined }>;
}) {
  const params = await searchParams;
  const statusFilter = params.status as ActivityStatus | undefined;
  const clientFilter = params.clientId;
  const assigneeFilter = params.assigneeId;

  // Filtered, counted and paged in the database: this table is every task
  // row there is (the whole KTAX history), far too many to send at once.
  const where: Prisma.ClientActivityWhereInput = {
    ...(statusFilter ? { status: statusFilter } : {}),
    ...(clientFilter ? { clientId: clientFilter } : {}),
    ...(assigneeFilter ? { assigneeId: assigneeFilter } : {}),
  };
  const total = await prisma.clientActivity.count({ where });
  const page = pageFromParams(params.page, total);

  const [rows, clients, employees] = await Promise.all([
    prisma.clientActivity.findMany({
      where,
      include: {
        client: { select: { companyName: true } },
        project: { select: { name: true } },
        subTask: { select: { name: true } },
      },
      orderBy: [{ clientId: "asc" }, { projectId: "asc" }, { periodName: "desc" }, { taskSeqNo: "asc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    prisma.client.findMany({ orderBy: { companyName: "asc" }, select: { id: true, companyName: true } }),
    prisma.employee.findMany({ orderBy: { firstName: "asc" } }),
  ]);

  const employeeOptions = employees.map((e) => ({
    id: e.id,
    name: `${e.firstName} ${e.lastName}`,
  }));

  return (
    <div className="mx-auto w-full max-w-6xl px-8 py-8">
      <Link href="/" className="text-sm text-ink-muted hover:text-accent">
        ← Back to home
      </Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">Admin Client Activity</h1>
      <p className="mt-1 text-sm text-ink-muted">
        Every task row across every client, project, and period, editable directly.
      </p>

      <div className="mt-6 mb-4 rounded-lg border border-line bg-surface px-4 py-3">
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
              <tr key={a.id} className="border-b border-line last:border-0 hover:bg-black/[0.015]">
                <td className="whitespace-nowrap px-4 py-2">
                  <Link
                    href={`/clients/${a.clientId}`}
                    className="font-medium text-ink hover:text-accent"
                  >
                    {a.client.companyName}
                  </Link>
                </td>
                <td className="whitespace-nowrap px-4 py-2 text-ink-muted">{a.project.name}</td>
                <td className="tabular whitespace-nowrap px-4 py-2 text-ink-muted">{a.periodName}</td>
                <td className="px-4 py-2 text-ink-muted">
                  <span className="flex items-baseline gap-2">
                    <span className="tabular w-5 shrink-0 text-right text-xs text-ink-muted/70">
                      {a.taskSeqNo}
                    </span>
                    <span className="text-ink">{a.subTask.name}</span>
                  </span>
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

      <Pager path="/admin/client-activity" params={params} page={page} total={total} noun={["task", "tasks"]} />
    </div>
  );
}
