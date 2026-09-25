import { prisma } from "@/lib/prisma";
import { FilterBar } from "@/components/filter-bar";
import { TasksTable, type TaskRow } from "@/components/tasks-table";
import { SavedViewsMenu } from "@/components/saved-views-menu";
import { dueDateUrgency, dueBucket, matchesDueFilter, DUE_FILTERS, type DueFilter } from "@/lib/dates";
import { requireUser, assigneeScope } from "@/lib/auth";
import { clientGroupNames, visibleTags, savedViewsFor } from "@/lib/client-options";
import { matchesClientFilters } from "@/lib/client-filters";
import { currentPeriodNames, engagementKey } from "@/lib/work-summary";
import { Pager, PAGE_SIZE, pageFromParams } from "@/components/pager";
import type { ActivityStatus } from "@prisma/client";

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

  // Only the active engagements' current periods are on this page, and there
  // are only a handful of distinct current period names at any time, so the
  // task query is narrowed to those periods in the database instead of loading
  // the whole task history. Names come from the small lookup tables rather
  // than a join per row.
  const assignments = await prisma.projectClientMap.findMany({
    where: { active: true, client: { archivedAt: null } },
    select: { clientId: true, projectId: true, currentPeriod: true, project: { select: { id: true, name: true } } },
  });

  const [activities, clients, lookupClients, projects, steps, employees, periods, groups, tags, views] = await Promise.all([
    prisma.clientActivity.findMany({
      where: {
        periodName: { in: currentPeriodNames(assignments) },
        client: { archivedAt: null },
        ...(statusFilter ? { status: statusFilter } : {}),
        ...(clientFilter ? { clientId: clientFilter } : {}),
        ...(projectFilter ? { projectId: projectFilter } : {}),
        ...(assigneeFilter ? { assigneeId: assigneeFilter } : {}),
      },
      select: {
        id: true,
        clientId: true,
        projectId: true,
        subTaskId: true,
        periodName: true,
        status: true,
        taskSeqNo: true,
        dueDate: true,
        dueDateOverridden: true,
        assigneeId: true,
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
    prisma.client.findMany({
      where: { archivedAt: null },
      select: { id: true, companyName: true, groupName: true, tags: { select: { tagId: true } } },
    }),
    prisma.project.findMany({ select: { id: true, name: true } }),
    prisma.projectSubTask.findMany({ select: { id: true, name: true } }),
    prisma.employee.findMany({ orderBy: [{ firstName: "asc" }, { lastName: "asc" }] }),
    prisma.accountingPeriod.findMany(),
    clientGroupNames(user),
    visibleTags(user),
    savedViewsFor(user, "/tasks"),
  ]);

  const clientById = new Map(lookupClients.map((c) => [c.id, c]));
  const projectName = new Map(projects.map((p) => [p.id, p.name]));
  const stepName = new Map(steps.map((s) => [s.id, s.name]));
  const employeeById = new Map(employees.map((e) => [e.id, e]));

  // Only tasks in each active assignment's *current* period.
  const currentKey = new Set(
    assignments.map((a) => engagementKey(a.clientId, a.projectId, a.currentPeriod ?? ""))
  );
  const periodByName = new Map(periods.map((p) => [p.name, p]));
  // Each step carries its own resolved deadline (project rule → client
  // override → step milestone), so two steps in the same period can
  // legitimately be due on different days. Falls back to the period end for
  // any row generated before due dates existed.
  const dueOf = (a: { dueDate: Date | null; periodName: string }) =>
    a.dueDate ?? periodByName.get(a.periodName)?.endDate ?? null;

  const allRows: TaskRow[] = activities
    .filter((a) => currentKey.has(engagementKey(a.clientId, a.projectId, a.periodName)))
    .flatMap((a) => {
      const client = clientById.get(a.clientId);
      if (!client) return [];
      return [
        {
          ...a,
          client,
          projectName: projectName.get(a.projectId) ?? "",
          stepName: stepName.get(a.subTaskId) ?? "",
          assignee: a.assigneeId ? employeeById.get(a.assigneeId) : undefined,
        },
      ];
    })
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
        a.projectName.toLowerCase().includes(query) ||
        a.stepName.toLowerCase().includes(query)
    )
    .filter((a) => !dueFilter || matchesDueFilter(dueBucket(dueOf(a), a.status), dueFilter))
    .map((a) => {
      const dueDate = dueOf(a);
      return {
        id: a.id,
        clientId: a.clientId,
        projectId: a.projectId,
        clientName: a.client.companyName,
        projectName: a.projectName,
        step: a.stepName,
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

  // Only one page of rows goes to the browser; the count covers them all.
  const page = pageFromParams(params.page, allRows.length);
  const rows = allRows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

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
              ? "Every checklist step assigned to you this period."
              : "Every checklist step in play across all clients this period."}
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
              {allRows.length} {allRows.length === 1 ? "task" : "tasks"}
            </span>
          }
        />
      </div>

      <TasksTable rows={rows} employees={employeeOptions} />

      <Pager path="/tasks" params={params} page={page} total={allRows.length} noun={["task", "tasks"]} />
    </div>
  );
}
