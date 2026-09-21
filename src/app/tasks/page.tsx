import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { StatusBadge } from "@/components/status-badge";
import { FilterBar } from "@/components/filter-bar";
import { formatDueDate, dueDateUrgency } from "@/lib/dates";
import { requireUser, assigneeScope } from "@/lib/auth";
import type { ActivityStatus } from "@prisma/client";

function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | undefined }>;
}) {
  const user = await requireUser();
  const mine = assigneeScope(user);
  const params = await searchParams;
  const statusFilter = params.status as ActivityStatus | undefined;
  const clientFilter = params.clientId;
  // Employees are pinned to their own tasks; the assignee chip is hidden.
  const assigneeFilter = mine ?? params.assigneeId;

  const [assignments, activities, clients, employees, periods] = await Promise.all([
    prisma.projectClientMap.findMany({ where: { active: true } }),
    prisma.clientActivity.findMany({
      include: { client: true, project: true, subTask: true, assignee: true },
      orderBy: { taskSeqNo: "asc" },
    }),
    prisma.client.findMany({
      // The Client chip must not list clients an employee can't see.
      where: mine ? { activities: { some: { assigneeId: mine } } } : undefined,
      orderBy: { companyName: "asc" },
    }),
    prisma.employee.findMany({ orderBy: [{ firstName: "asc" }, { lastName: "asc" }] }),
    prisma.accountingPeriod.findMany(),
  ]);

  // Only tasks in each active assignment's *current* period.
  const currentKey = new Set(
    assignments.map((a) => `${a.clientId}:${a.projectId}:${a.currentPeriod}`)
  );
  const periodByName = new Map(periods.map((p) => [p.name, p]));

  const rows = activities
    .filter((a) =>
      currentKey.has(`${a.clientId}:${a.projectId}:${a.periodName}`)
    )
    .filter((a) => !statusFilter || a.status === statusFilter)
    .filter((a) => !clientFilter || a.clientId === clientFilter)
    .filter((a) => !assigneeFilter || a.assigneeId === assigneeFilter)
    .map((a) => ({
      id: a.id,
      clientId: a.clientId,
      projectId: a.projectId,
      clientName: a.client.companyName,
      projectName: a.project.name,
      step: a.subTask.name,
      status: a.status,
      assigneeName: a.assignee
        ? `${a.assignee.firstName} ${a.assignee.lastName}`
        : "Unassigned",
      // Each step carries its own resolved deadline now (project rule →
      // client override → step milestone), so two steps in the same period
      // can legitimately be due on different days. Falls back to the period
      // end for any row generated before due dates existed.
      dueDate: a.dueDate ?? periodByName.get(a.periodName)?.endDate ?? null,
      dueOverridden: a.dueDateOverridden,
    }))
    .sort((x, y) => {
      if (!x.dueDate) return 1;
      if (!y.dueDate) return -1;
      return x.dueDate.getTime() - y.dueDate.getTime();
    });

  return (
    <div className="mx-auto w-full max-w-6xl px-8 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Tasks</h1>
        <p className="mt-1 text-sm text-ink-muted">
          {mine
            ? "Every checklist step assigned to you this period."
            : "Every checklist step in play across all clients this period."}
        </p>
      </div>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-surface px-4 py-3">
        <FilterBar
          clients={clients.map((c) => ({ value: c.id, label: c.companyName }))}
          employees={
            mine
              ? undefined
              : employees.map((e) => ({ value: e.id, label: `${e.firstName} ${e.lastName}` }))
          }
        />
        <span className="whitespace-nowrap text-sm text-ink-muted">
          {rows.length} {rows.length === 1 ? "task" : "tasks"}
        </span>
      </div>

      <div className="overflow-hidden rounded-lg border border-line bg-surface shadow-sm">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-line bg-black/[0.02] text-xs uppercase tracking-wide text-ink-muted">
              <th className="px-4 py-3 font-medium">Client</th>
              <th className="px-4 py-3 font-medium">Project</th>
              <th className="px-4 py-3 font-medium">Step</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Assignee</th>
              <th className="px-4 py-3 font-medium">Due</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const urgency = dueDateUrgency(r.dueDate, r.status);
              return (
                <tr
                  key={r.id}
                  className="border-b border-line last:border-0 hover:bg-black/[0.015]"
                >
                  <td className="px-4 py-3 align-middle text-ink-muted">
                    {r.clientName}
                  </td>
                  <td className="px-4 py-3 align-middle text-ink-muted">
                    {r.projectName}
                  </td>
                  <td className="px-4 py-3 align-middle">
                    <Link
                      href={`/assignments/${r.clientId}/${r.projectId}`}
                      className="font-medium text-ink hover:text-accent"
                    >
                      {r.step}
                    </Link>
                  </td>
                  <td className="px-4 py-3 align-middle">
                    <StatusBadge status={r.status} />
                  </td>
                  <td className="px-4 py-3 align-middle">
                    <div className="flex items-center gap-2 text-ink-muted">
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[10px] font-medium text-accent">
                        {initials(r.assigneeName)}
                      </span>
                      {r.assigneeName}
                    </div>
                  </td>
                  <td
                    className={`tabular px-4 py-3 align-middle ${
                      urgency === "overdue"
                        ? "font-medium text-overdue"
                        : urgency === "soon"
                        ? "font-medium text-[var(--status-review)]"
                        : "text-ink-muted"
                    }`}
                  >
                    {formatDueDate(r.dueDate)}
                    {r.dueOverridden && (
                      <span
                        title="This date was set by hand and won't change when the service's due-date rule changes."
                        className="ml-1 text-ink-muted"
                      >
                        *
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-ink-muted">
                  No tasks match these filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
