import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { FilterBar } from "@/components/filter-bar";
import { DashboardTable, type DashboardRow } from "@/components/dashboard-table";
import { SavedViewsMenu } from "@/components/saved-views-menu";
import { DueSummaryCards } from "@/components/due-summary-cards";
import { deriveAssignmentStatus, progressLabel } from "@/lib/workflow";
import {
  dueDateUrgency,
  dueBucket,
  matchesDueFilter,
  DUE_FILTERS,
  type DueFilter,
} from "@/lib/dates";
import { requireUser } from "@/lib/auth";
import { canSee, visibleScope } from "@/lib/access";
import { formatPeriodName } from "@/lib/period-names";
import { engagementHref, engagementKeyString, engagementLabel } from "@/lib/engagements";
import { ensurePeriodsCurrent } from "@/lib/scheduler";
import { clientGroupNames, visibleTags, savedViewsFor } from "@/lib/client-options";
import { matchesClientFilters } from "@/lib/client-filters";
import type { ActivityStatus } from "@prisma/client";

type View = "all" | "open" | "completed";
const VIEWS: { id: View; label: string }[] = [
  { id: "all", label: "All" },
  { id: "open", label: "Open" },
  { id: "completed", label: "Completed" },
];

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | undefined }>;
}) {
  const user = await requireUser();
  // Lazy catch-up so the board is never built from stale data: if the nightly
  // job hasn't run recently (or there's no cron attached at all, which is the
  // case running locally), open any periods that are due before we read. No-op
  // and one indexed query when cron is healthy. PERIOD_AUTOGEN=off disables it.
  await ensurePeriodsCurrent();
  // Project-level visibility: an employee sees every engagement they're
  // responsible for or have a task in — the whole engagement, not just their
  // own steps (src/lib/access.ts). null = admin, everything.
  const scope = await visibleScope(user);
  const mine = scope !== null;
  const params = await searchParams;
  const statusFilter = params.status as ActivityStatus | undefined;
  const clientFilter = params.clientId;
  const assigneeFilter = params.assigneeId;
  const dueFilter = (DUE_FILTERS as readonly string[]).includes(params.due ?? "")
    ? (params.due as DueFilter)
    : null;
  const projectFilter = params.projectId;
  const periodFilter = params.period;
  const query = (params.q ?? "").trim().toLowerCase();
  const view: View =
    params.view === "open" || params.view === "completed" ? params.view : "all";

  const [assignments, allActivities, periods, clients, employees, clientGroups, tags, views] = await Promise.all([
    // Every engagement, including ones marked inactive — a finished one-time
    // project is inactive but still belongs under Completed. Archived clients
    // are off the board entirely (they're under Clients → Archived).
    prisma.projectClientMap.findMany({
      where: { client: { archivedAt: null } },
      include: {
        client: { include: { tags: { select: { tagId: true } } } },
        project: { include: { owner: true } },
        defaultAssignee: true,
      },
    }),
    prisma.clientActivity.findMany({
      where: { client: { archivedAt: null } },
      include: { assignee: true, subTask: true },
    }),
    prisma.accountingPeriod.findMany(),
    prisma.client.findMany({
      // The Client chip must not list clients an employee can't see.
      where: {
        archivedAt: null,
        ...(scope ? { id: { in: [...scope.clientIds] } } : {}),
      },
      orderBy: { companyName: "asc" },
    }),
    prisma.employee.findMany({ orderBy: { firstName: "asc" } }),
    clientGroupNames(user),
    visibleTags(user),
    savedViewsFor(user, "/"),
  ]);

  const periodByName = new Map(periods.map((p) => [p.name, p]));
  const assignmentByKey = new Map(assignments.map((a) => [engagementKeyString(a), a]));

  // One dashboard row per engagement + period. An engagement is one copy of a
  // project for one client — a client running "Bookkeeping" twice has two
  // rows. A finished period stays on the board as its own completed row; the
  // period that rolled forward is a separate, fresh row.
  const groups = new Map<string, { engagement: string; periodName: string; acts: typeof allActivities }>();
  const groupFor = (engagement: string, periodName: string) => {
    const key = `${engagement}\u0000${periodName}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { engagement, periodName, acts: [] }));
    return g;
  };
  for (const act of allActivities) groupFor(engagementKeyString(act), act.periodName).acts.push(act);
  // An engagement whose current period has no task rows yet still shows up.
  for (const a of assignments) {
    if (a.currentPeriod) groupFor(engagementKeyString(a), a.currentPeriod);
  }

  const visible = [...groups.values()]
    .flatMap(({ engagement, periodName, acts }) => {
      const a = assignmentByKey.get(engagement);
      if (!a) return [];
      const { clientId, projectId, instance } = a;
      // Employees see the engagements they're on — every step of them.
      if (!canSee(scope, a)) return [];
      const status = deriveAssignmentStatus(acts);
      const completed = acts.length > 0 && status === "DONE";
      const isCurrent = a.currentPeriod === periodName;
      const sorted = [...acts].sort((x, y) => x.taskSeqNo - y.taskSeqNo);
      const activeTask = sorted.find((act) => act.status !== "DONE") ?? sorted[sorted.length - 1];
      // The row's due date is the next thing actually owed on it: the earliest
      // open step's deadline. Once everything is done it's the last deadline
      // the engagement had. Steps can carry their own milestone offsets, so
      // this is no longer the same date for every row in a period.
      const open = sorted.filter((act) => act.status !== "DONE" && act.dueDate);
      const dated = sorted.filter((act) => act.dueDate);
      const dueDate =
        (open.length > 0
          ? open.reduce((min, act) => (act.dueDate! < min.dueDate! ? act : min)).dueDate
          : dated.length > 0
          ? dated.reduce((max, act) => (act.dueDate! > max.dueDate! ? act : max)).dueDate
          : periodByName.get(periodName)?.endDate) ?? null;
      const doneCount = acts.filter((act) => act.status === "DONE").length;
      const totalCount = acts.length;
      // Who's responsible is decided at the project level: this engagement's
      // owner, else the project's owner. A step-level assignee is only the
      // fallback when nobody owns the engagement.
      const responsible = a.defaultAssignee ?? a.project.owner ?? activeTask?.assignee ?? null;
      return [
        {
          clientId,
          projectId,
          instance,
          periodName,
          isCurrent,
          completed,
          href: engagementHref(a, { period: isCurrent ? null : periodName }),
          clientName: a.client.companyName,
          groupName: a.client.groupName,
          tagIds: a.client.tags.map((t) => t.tagId),
          projectName: engagementLabel(a.project.name, a.name, instance),
          period: periodName,
          status,
          progress: progressLabel(acts),
          progressPct: totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0,
          dueDate,
          assigneeName: responsible ? `${responsible.firstName} ${responsible.lastName}` : "Unassigned",
          assigneeId: responsible?.id ?? null,
          due: dueBucket(dueDate, status),
        },
      ];
    })
    .filter((r) => !statusFilter || r.status === statusFilter)
    .filter((r) => !clientFilter || r.clientId === clientFilter)
    .filter((r) => !assigneeFilter || r.assigneeId === assigneeFilter)
    .filter((r) => !projectFilter || r.projectId === projectFilter)
    .filter((r) => !periodFilter || r.period === periodFilter)
    .filter((r) => matchesClientFilters(r, { group: params.group, tag: params.tag }))
    .filter(
      (r) =>
        !query ||
        r.clientName.toLowerCase().includes(query) ||
        r.projectName.toLowerCase().includes(query) ||
        (r.groupName ?? "").toLowerCase().includes(query)
    );

  // Chip options come from what's actually on the board, so the Project and
  // Period menus never list something that can't match a row.
  const projectOptions = [...new Map(assignments.map((a) => [a.projectId, a.project.name]))]
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const periodOptions = [...new Set([...groups.values()].map((g) => g.periodName))]
    .sort((a, b) => {
      const pa = periodByName.get(a)?.startDate.getTime() ?? 0;
      const pb = periodByName.get(b)?.startDate.getTime() ?? 0;
      return pb - pa || b.localeCompare(a);
    })
    .map((p) => ({ value: p, label: formatPeriodName(p) }));

  // Counts reflect the status/client/assignee filters but not the due filter
  // itself, so every card stays readable while one of them is active.
  const dueCounts = Object.fromEntries(
    DUE_FILTERS.map((f) => [f, visible.filter((r) => matchesDueFilter(r.due, f)).length])
  ) as Record<DueFilter, number>;

  const otherParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (key !== "due" && value) otherParams.set(key, value);
  }

  const byDueAsc = (a: { dueDate: Date | null }, b: { dueDate: Date | null }) => {
    if (!a.dueDate) return 1;
    if (!b.dueDate) return -1;
    return a.dueDate.getTime() - b.dueDate.getTime();
  };
  const openRows = visible.filter((r) => !r.completed).sort(byDueAsc);
  // Most recently finished first.
  const completedRows = visible.filter((r) => r.completed).sort((a, b) => -byDueAsc(a, b));

  const rows =
    view === "open" ? openRows : view === "completed" ? completedRows : [...openRows, ...completedRows];
  const viewCounts: Record<View, number> = {
    all: visible.length,
    open: openRows.length,
    completed: completedRows.length,
  };

  function viewHref(id: View): string {
    const p = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (key !== "view" && value) p.set(key, value);
    }
    if (id !== "all") p.set("view", id);
    const q = p.toString();
    return q ? `/?${q}` : "/";
  }

  const firstCompletedIndex = view === "all" ? openRows.length : -1;

  const tableRows: DashboardRow[] = rows.map((r) => ({
    key: `${engagementKeyString(r)}\u0000${r.periodName}`,
    clientId: r.clientId,
    projectId: r.projectId,
    instance: r.instance,
    periodName: r.periodName,
    href: r.href,
    clientName: r.clientName,
    projectName: r.projectName,
    completed: r.completed,
    status: r.status,
    progress: r.progress,
    progressPct: r.progressPct,
    dueDate: r.dueDate ? r.dueDate.toISOString() : null,
    urgency: dueDateUrgency(r.dueDate, r.status),
    assigneeName: r.assigneeName,
  }));

  return (
    <div className="mx-auto w-full max-w-6xl px-8 py-8">
      <div className="mb-6 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="mt-1 text-sm text-ink-muted">
            {mine
              ? "Every project you're assigned to (or have a task in), one row per period."
              : "Every client engagement, one row per period."}{" "}
            Finished periods stay on the board under Completed.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <SavedViewsMenu path="/" views={views} isAdmin={user.role === "ADMIN"} />
          {user.role === "ADMIN" && (
            <Link
              href="/clients/new"
              className="whitespace-nowrap rounded-full bg-accent px-4 py-2 text-sm font-medium text-white shadow-sm hover:opacity-90"
            >
              + New Client
            </Link>
          )}
        </div>
      </div>

      <div className="mb-4 inline-flex rounded-md border border-line bg-surface p-0.5 shadow-sm">
        {VIEWS.map((v) => {
          const active = v.id === view;
          return (
            <Link
              key={v.id}
              href={viewHref(v.id)}
              aria-current={active ? "page" : undefined}
              className={`flex items-center gap-1.5 rounded px-3 py-1.5 text-sm font-medium transition-colors ${
                active ? "bg-accent-soft text-accent" : "text-ink-muted hover:text-ink"
              }`}
            >
              {v.label}
              <span
                className={`count-pill ${
                  active ? "bg-accent/15 text-accent" : "bg-black/5 text-ink-muted"
                }`}
              >
                {viewCounts[v.id]}
              </span>
            </Link>
          );
        })}
      </div>

      <DueSummaryCards counts={dueCounts} active={dueFilter} otherParams={otherParams} />

      <div className="mb-4 rounded-lg border border-line bg-surface px-4 py-3">
        <FilterBar
          search
          searchPlaceholder="Search by client, group or project"
          due
          clients={clients.map((c) => ({ value: c.id, label: c.companyName }))}
          employees={
            mine
              ? undefined
              : employees.map((e) => ({ value: e.id, label: `${e.firstName} ${e.lastName}` }))
          }
          projects={projectOptions}
          periods={periodOptions}
          groups={clientGroups.map((g) => ({ value: g, label: g }))}
          tags={tags.map((t) => ({ value: t.id, label: t.name }))}
          trailing={
            <span className="whitespace-nowrap text-sm text-ink-muted">
              {rows.length} {rows.length === 1 ? "project" : "projects"}
            </span>
          }
        />
      </div>

      <DashboardTable
        rows={tableRows}
        completedCount={completedRows.length}
        firstCompletedIndex={firstCompletedIndex}
        emptyMessage={view === "completed" ? "Nothing completed yet." : "No work matches these filters."}
        employees={employees.map((e) => ({ value: e.id, label: `${e.firstName} ${e.lastName}` }))}
      />
    </div>
  );
}
