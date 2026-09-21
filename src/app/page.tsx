import { Fragment } from "react";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { StatusBadge } from "@/components/status-badge";
import { FilterBar } from "@/components/filter-bar";
import { DueSummaryCards } from "@/components/due-summary-cards";
import { deriveAssignmentStatus, progressLabel } from "@/lib/workflow";
import {
  formatDueDate,
  dueDateUrgency,
  dueBucket,
  matchesDueFilter,
  DUE_FILTERS,
  type DueFilter,
} from "@/lib/dates";
import { requireUser, assigneeScope } from "@/lib/auth";
import { ensurePeriodsCurrent } from "@/lib/scheduler";
import type { ActivityStatus } from "@prisma/client";

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return parts
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

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
  const mine = assigneeScope(user);
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

  const [assignments, allActivities, periods, clients, employees] = await Promise.all([
    // Every engagement, including ones marked inactive — a finished one-time
    // project is inactive but still belongs under Completed.
    prisma.projectClientMap.findMany({
      include: { client: true, project: true },
    }),
    prisma.clientActivity.findMany({
      include: { assignee: true, subTask: true },
    }),
    prisma.accountingPeriod.findMany(),
    prisma.client.findMany({
      // The Client chip must not list clients an employee can't see.
      where: mine ? { activities: { some: { assigneeId: mine } } } : undefined,
      orderBy: { companyName: "asc" },
    }),
    prisma.employee.findMany({ orderBy: { firstName: "asc" } }),
  ]);

  const periodByName = new Map(periods.map((p) => [p.name, p]));
  const assignmentByKey = new Map(assignments.map((a) => [`${a.clientId}:${a.projectId}`, a]));

  // One dashboard row per client + project + period. A finished period stays
  // on the board as its own completed row; the period that rolled forward is
  // a separate, fresh row. Nothing is reset or overwritten by rollover.
  const groups = new Map<string, typeof allActivities>();
  for (const act of allActivities) {
    const key = `${act.clientId}:${act.projectId}:${act.periodName}`;
    const list = groups.get(key);
    if (list) list.push(act);
    else groups.set(key, [act]);
  }
  // An engagement whose current period has no task rows yet still shows up.
  for (const a of assignments) {
    if (!a.currentPeriod) continue;
    const key = `${a.clientId}:${a.projectId}:${a.currentPeriod}`;
    if (!groups.has(key)) groups.set(key, []);
  }

  const visible = [...groups.entries()]
    .flatMap(([key, acts]) => {
      const [clientId, projectId, periodName] = key.split(":");
      const a = assignmentByKey.get(`${clientId}:${projectId}`);
      if (!a) return [];
      // Employees only see periods where at least one step is theirs.
      if (mine && !acts.some((act) => act.assigneeId === mine)) return [];
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
      const base = `/assignments/${clientId}/${projectId}`;
      return [
        {
          clientId,
          projectId,
          periodName,
          isCurrent,
          completed,
          href: isCurrent ? base : `${base}?period=${encodeURIComponent(periodName)}`,
          clientName: a.client.companyName,
          projectName: a.project.name,
          period: periodName,
          status,
          progress: progressLabel(acts),
          progressPct: totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0,
          dueDate,
          assigneeName: activeTask?.assignee
            ? `${activeTask.assignee.firstName} ${activeTask.assignee.lastName}`
            : "Unassigned",
          assigneeId: activeTask?.assigneeId ?? null,
          due: dueBucket(dueDate, status),
        },
      ];
    })
    .filter((r) => !statusFilter || r.status === statusFilter)
    .filter((r) => !clientFilter || r.clientId === clientFilter)
    .filter((r) => !assigneeFilter || r.assigneeId === assigneeFilter)
    .filter((r) => !projectFilter || r.projectId === projectFilter)
    .filter((r) => !periodFilter || r.period === periodFilter)
    .filter(
      (r) =>
        !query ||
        r.clientName.toLowerCase().includes(query) ||
        r.projectName.toLowerCase().includes(query)
    );

  // Chip options come from what's actually on the board, so the Project and
  // Period menus never list something that can't match a row.
  const projectOptions = [...new Map(assignments.map((a) => [a.projectId, a.project.name]))]
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const periodOptions = [...new Set([...groups.keys()].map((k) => k.split(":")[2]))]
    .sort((a, b) => {
      const pa = periodByName.get(a)?.startDate.getTime() ?? 0;
      const pb = periodByName.get(b)?.startDate.getTime() ?? 0;
      return pb - pa || b.localeCompare(a);
    })
    .map((p) => ({ value: p, label: p }));

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

  return (
    <div className="mx-auto w-full max-w-6xl px-8 py-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="mt-1 text-sm text-ink-muted">
            {mine
              ? "Every engagement with a task assigned to you, one row per period."
              : "Every client engagement, one row per period."}{" "}
            Finished periods stay on the board under Completed.
          </p>
        </div>
        <Link
          href="/clients/new"
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white shadow-sm hover:opacity-90"
        >
          + New Client
        </Link>
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
                className={`tabular rounded-full px-1.5 text-[11px] ${
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
          searchPlaceholder="Search by client name or project"
          due
          clients={clients.map((c) => ({ value: c.id, label: c.companyName }))}
          employees={
            mine
              ? undefined
              : employees.map((e) => ({ value: e.id, label: `${e.firstName} ${e.lastName}` }))
          }
          projects={projectOptions}
          periods={periodOptions}
          trailing={
            <span className="whitespace-nowrap text-sm text-ink-muted">
              {rows.length} {rows.length === 1 ? "project" : "projects"}
            </span>
          }
        />
      </div>

      <div className="overflow-hidden rounded-lg border border-line bg-surface shadow-sm">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-line bg-black/[0.02] text-xs uppercase tracking-wide text-ink-muted">
              <th className="px-4 py-3 font-medium">Client</th>
              <th className="px-4 py-3 font-medium">Project</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Assigned to</th>
              <th className="px-4 py-3 font-medium">Due</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const urgency = dueDateUrgency(r.dueDate, r.status);
              const divider =
                i === firstCompletedIndex && completedRows.length > 0 ? (
                  <tr key="completed-divider" className="border-b border-line bg-black/[0.03]">
                    <td colSpan={5} className="px-4 py-2 text-[11px] font-medium uppercase tracking-wide text-ink-muted">
                      Completed · {completedRows.length}
                    </td>
                  </tr>
                ) : null;
              return (
                <Fragment key={`${r.clientId}-${r.projectId}-${r.periodName}`}>
                  {divider}
                  <tr
                    className={`border-b border-line last:border-0 hover:bg-black/[0.015] ${
                      r.completed ? "bg-black/[0.01]" : ""
                    }`}
                  >
                    <td className="px-4 py-4 align-middle">
                      <Link
                        href={r.href}
                        className={`font-medium hover:text-accent ${
                          r.completed ? "text-ink-muted" : "text-ink"
                        }`}
                      >
                        {r.clientName}
                      </Link>
                    </td>
                    <td className="px-4 py-4 align-middle">
                      <div className="flex items-center gap-2">
                        <Link href={r.href} className="text-ink-muted hover:text-accent">
                          {r.projectName}
                        </Link>
                        <span className="tabular rounded-full bg-black/5 px-1.5 py-0.5 text-[10px] text-ink-muted">
                          {r.period}
                        </span>
                      </div>
                      <div className="mt-2 flex items-center gap-2">
                        <div className="h-1.5 w-28 overflow-hidden rounded-full bg-line">
                          <div
                            className={`h-full rounded-full ${r.completed ? "bg-accent/50" : "bg-accent"}`}
                            style={{ width: `${r.progressPct}%` }}
                          />
                        </div>
                        <span className="tabular text-[11px] text-ink-muted">{r.progress}</span>
                      </div>
                    </td>
                    <td className="px-4 py-4 align-middle">
                      <StatusBadge status={r.status} />
                    </td>
                    <td className="px-4 py-4 align-middle">
                      <div className="flex items-center gap-2 text-ink-muted">
                        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[10px] font-medium text-accent">
                          {initials(r.assigneeName)}
                        </span>
                        {r.assigneeName}
                      </div>
                    </td>
                    <td
                      className={`px-4 py-4 align-middle tabular ${
                        r.completed
                          ? "text-ink-muted"
                          : urgency === "overdue"
                          ? "font-medium text-overdue"
                          : urgency === "soon"
                          ? "font-medium text-[var(--status-review)]"
                          : "text-ink-muted"
                      }`}
                    >
                      {formatDueDate(r.dueDate)}
                    </td>
                  </tr>
                </Fragment>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center text-ink-muted">
                  {view === "completed"
                    ? "Nothing completed yet."
                    : "No work matches these filters."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
