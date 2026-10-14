import { prisma } from "@/lib/prisma";
import { FilterBar } from "@/components/filter-bar";
import { TasksTable, type TaskRow } from "@/components/tasks-table";
import { SavedViewsMenu } from "@/components/saved-views-menu";
import { dueDateUrgency, dueBucket, matchesDueFilter, DUE_FILTERS, type DueFilter } from "@/lib/dates";
import { requireUser, assigneeScope } from "@/lib/auth";
import { clientGroupNames, visibleTags, savedViewsFor } from "@/lib/client-options";
import { matchesClientFilters } from "@/lib/client-filters";
import type { ActivityStatus } from "@prisma/client";
import { periodsInPlay } from "@/lib/workflow";
import { formatPeriodName } from "@/lib/period-names";

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
  const projectFilter = params.projectId;
  // Employees are pinned to their own tasks; the assignee chip is hidden.
  const assigneeFilter = mine ?? params.assigneeId;
  const dueFilter = (DUE_FILTERS as readonly string[]).includes(params.due ?? "")
    ? (params.due as DueFilter)
    : null;
  const query = (params.q ?? "").trim().toLowerCase();

  const [assignments, activities, clients, employees, periods, groups, tags, views] = await Promise.all([
    // Archived clients are off the books: their work doesn't appear here.
    prisma.projectClientMap.findMany({
      where: { active: true, client: { archivedAt: null } },
      include: { project: { select: { id: true, name: true } } },
    }),
    prisma.clientActivity.findMany({
      where: { client: { archivedAt: null } },
      include: {
        client: { include: { tags: { select: { tagId: true } } } },
        project: true,
        subTask: true,
        assignee: true,
      },
      orderBy: { taskSeqNo: "asc" },
    }),
    prisma.client.findMany({
      // The Client chip must not list clients an employee can't see.
      where: {
        archivedAt: null,
        ...(mine ? { activities: { some: { assigneeId: mine } } } : {}),
      },
      orderBy: { companyName: "asc" },
    }),
    prisma.employee.findMany({ orderBy: [{ firstName: "asc" }, { lastName: "asc" }] }),
    prisma.accountingPeriod.findMany(),
    clientGroupNames(user),
    visibleTags(user),
    savedViewsFor(user, "/tasks"),
  ]);

  // Tasks in every period that's in play for each active assignment: the
  // current one, plus earlier ones that still have unfinished work (two
  // periods of the same project can run at once).
  const currentPeriodOf = new Map(assignments.map((a) => [`${a.clientId}:${a.projectId}`, a.currentPeriod]));
  const rowsByEngagement = new Map<string, typeof activities>();
  for (const a of activities) {
    const k = `${a.clientId}:${a.projectId}`;
    const list = rowsByEngagement.get(k);
    if (list) list.push(a);
    else rowsByEngagement.set(k, [a]);
  }
  const currentKey = new Set<string>();
  for (const [k, current] of currentPeriodOf) {
    for (const p of periodsInPlay(rowsByEngagement.get(k) ?? [], current)) currentKey.add(`${k}:${p}`);
  }
  const periodByName = new Map(periods.map((p) => [p.name, p]));
  // Each step carries its own resolved deadline (project rule → client
  // override → step milestone), so two steps in the same period can
  // legitimately be due on different days. Falls back to the period end for
  // any row generated before due dates existed.
  const dueOf = (a: (typeof activities)[number]) =>
    a.dueDate ?? periodByName.get(a.periodName)?.endDate ?? null;

  const rows: TaskRow[] = activities
    .filter((a) => currentKey.has(`${a.clientId}:${a.projectId}:${a.periodName}`))
    .filter((a) => !statusFilter || a.status === statusFilter)
    .filter((a) => !clientFilter || a.clientId === clientFilter)
    .filter((a) => !projectFilter || a.projectId === projectFilter)
    .filter((a) => !assigneeFilter || a.assigneeId === assigneeFilter)
    .filter((a) =>
      matchesClientFilters(
        { groupName: a.client.groupName, tagIds: a.client.tags.map((t) => t.tagId) },
        { group: params.group, tag: params.tag }
      )
    )
    .filter(
      (a) =>
        !query ||
        a.client.companyName.toLowerCase().includes(query) ||
        a.project.name.toLowerCase().includes(query) ||
        a.subTask.name.toLowerCase().includes(query)
    )
    .filter((a) => !dueFilter || matchesDueFilter(dueBucket(dueOf(a), a.status), dueFilter))
    .map((a) => {
      const dueDate = dueOf(a);
      return {
        id: a.id,
        clientId: a.clientId,
        projectId: a.projectId,
        clientName: a.client.companyName,
        projectName: a.project.name,
        periodLabel:
          currentPeriodOf.get(`${a.clientId}:${a.projectId}`) === a.periodName
            ? null
            : `${formatPeriodName(a.periodName)} · still open`,
        href:
          currentPeriodOf.get(`${a.clientId}:${a.projectId}`) === a.periodName
            ? `/assignments/${a.clientId}/${a.projectId}`
            : `/assignments/${a.clientId}/${a.projectId}?period=${encodeURIComponent(a.periodName)}`,
        step: a.subTask.name,
        status: a.status,
        assigneeName: a.assignee ? `${a.assignee.firstName} ${a.assignee.lastName}` : "Unassigned",
        dueDate: dueDate ? dueDate.toISOString() : null,
        dueOverridden: a.dueDateOverridden,
        urgency: dueDateUrgency(dueDate, a.status),
      };
    })
    .sort((x, y) => {
      if (!x.dueDate) return 1;
      if (!y.dueDate) return -1;
      return x.dueDate.localeCompare(y.dueDate);
    });

  const projectOptions = [...new Map(assignments.map((a) => [a.project.id, a.project.name]))]
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const employeeOptions = employees.map((e) => ({ value: e.id, label: `${e.firstName} ${e.lastName}` }));

  return (
    <div className="mx-auto w-full max-w-6xl px-8 py-8">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Tasks</h1>
          <p className="mt-1 text-sm text-ink-muted">
            {mine
              ? "Every checklist step assigned to you that's in play — this period, and any earlier period still open."
              : "Every checklist step in play across all clients — this period, and any earlier period still open."}
          </p>
        </div>
        <SavedViewsMenu path="/tasks" views={views} isAdmin={user.role === "ADMIN"} />
      </div>

      <div className="mb-4 rounded-lg border border-line bg-surface px-4 py-3">
        <FilterBar
          search
          searchPlaceholder="Search client, project or step"
          due
          clients={clients.map((c) => ({ value: c.id, label: c.companyName }))}
          employees={mine ? undefined : employeeOptions}
          projects={projectOptions}
          groups={groups.map((g) => ({ value: g, label: g }))}
          tags={tags.map((t) => ({ value: t.id, label: t.name }))}
          trailing={
            <span className="whitespace-nowrap text-sm text-ink-muted">
              {rows.length} {rows.length === 1 ? "task" : "tasks"}
            </span>
          }
        />
      </div>

      <TasksTable rows={rows} employees={employeeOptions} />
    </div>
  );
}
