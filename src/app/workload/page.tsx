import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";
import { loggedMinutesByEmployee } from "@/lib/time-data";
import { resolveRange, formatMinutes, toDecimalHours } from "@/lib/time";
import {
  summarizeWorkload,
  computeLoad,
  suggestAssignee,
  LOAD_LABELS,
  type Load,
  type WorkloadSummary,
} from "@/lib/workload";
import { ExportBar } from "@/components/export-bar";

// Workload and capacity.
//
// The gap: the app could assign work but showed nothing about how much anyone
// was already carrying, so every assignment decision was made blind.
//
// Admin-only, for the same reason the reports are: this is a firm-wide view of
// every colleague's load, and an employee scoped to their own clients would see
// the rest of the firm through it.
//
// What makes the numbers honest rather than merely present:
//   - Open tasks and committed hours are separate answers. A person with
//     twelve unestimated tasks is carrying twelve tasks of UNKNOWN size, not
//     zero hours, and the table says so in its own column instead of showing a
//     confident 0h.
//   - The load bar is drawn only where there is both a capacity on file and at
//     least one estimate. Anything else would be a bar drawn from no data.
//   - Nothing here blocks an assignment. It makes the number visible; the
//     decision stays with a person.
export default async function WorkloadPage() {
  await requireAdmin();

  const thisWeek = resolveRange("this-week");

  const [employees, openTasks, logged, unassignedCount] = await Promise.all([
    prisma.employee.findMany({
      include: { employeeType: true },
      orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
    }),
    prisma.clientActivity.findMany({
      where: { status: { not: "DONE" }, assigneeId: { not: null } },
      select: {
        assigneeId: true,
        status: true,
        dueDate: true,
        estimatedMinutes: true,
      },
    }),
    loggedMinutesByEmployee(thisWeek),
    // Work nobody is carrying is the other half of the capacity question, and
    // it is invisible in a per-person table by construction.
    prisma.clientActivity.count({
      where: { status: { not: "DONE" }, assigneeId: null },
    }),
  ]);

  const people = employees.map((e) => {
    const mine = openTasks.filter((t) => t.assigneeId === e.id);
    const summary = summarizeWorkload(mine);
    const load = computeLoad({
      committedMinutes: summary.committedMinutes,
      weeklyCapacityMinutes: e.weeklyCapacityMinutes,
      estimatedCount: summary.estimatedCount,
    });
    return {
      id: e.id,
      name: `${e.firstName} ${e.lastName}`,
      role: e.employeeType?.name ?? (e.role === "ADMIN" ? "Admin" : "Employee"),
      capacityMinutes: e.weeklyCapacityMinutes,
      loggedThisWeek: logged.get(e.id) ?? 0,
      summary,
      load,
    };
  });

  // Only offered when somebody actually has a measurable load — otherwise the
  // "suggestion" is just whoever happens to sort first.
  const withWork = people.filter((p) => p.summary.openCount > 0 || p.load.percent !== null);
  const suggestion = withWork.length > 1 ? suggestAssignee(people) : null;

  const anyCapacity = people.some((p) => p.capacityMinutes !== null);
  const anyEstimates = people.some((p) => p.summary.estimatedCount > 0);

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-10">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Workload</h1>
          <p className="mt-1 text-sm text-ink-muted">
            What each person is carrying right now, so an assignment isn&apos;t a guess.
          </p>
        </div>
        <ExportBar reportKey="workload" />
      </div>

      {/* Setup prompts, shown only while the thing they ask for is missing.
          A capacity view with no capacities is a list of counts, and saying so
          beats rendering empty bars and letting someone conclude the feature
          is broken. */}
      {!anyEstimates && (
        <p className="mt-4 rounded-md border border-line bg-surface px-3 py-2 text-xs text-ink-muted">
          No checklist step has a time estimate yet, so this shows task counts but no hours.
          Add estimates on a project&apos;s checklist (Projects → open a service), and every
          task generated from then on carries one.
        </p>
      )}
      {anyEstimates && !anyCapacity && (
        <p className="mt-4 rounded-md border border-line bg-surface px-3 py-2 text-xs text-ink-muted">
          No weekly capacity is set for anyone, so committed hours are shown without a
          load bar. Set capacity in Admin → Employees.
        </p>
      )}

      {suggestion && suggestion.summary.openCount >= 0 && (
        <p className="mt-4 rounded-md border border-accent/30 bg-accent-soft px-3 py-2 text-xs text-accent">
          Lightest load right now: <span className="font-medium">{suggestion.name}</span>
          {suggestion.load.percent !== null
            ? ` — ${suggestion.load.percent}% of capacity committed.`
            : ` — ${suggestion.summary.openCount} open task${suggestion.summary.openCount === 1 ? "" : "s"}.`}
        </p>
      )}

      {unassignedCount > 0 && (
        <p className="mt-3 rounded-md border border-[var(--status-review)]/30 bg-[var(--status-review-soft)] px-3 py-2 text-xs text-[var(--status-review)]">
          <Link href="/tasks" className="font-medium hover:underline">
            {unassignedCount} open task{unassignedCount === 1 ? " is" : "s are"} unassigned
          </Link>{" "}
          and carried by nobody. Setting default assignees on a service or an engagement
          stops new periods arriving blank.
        </p>
      )}

      <div className="mt-6 overflow-hidden rounded-lg border border-line bg-surface">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-line bg-black/[0.02] text-xs tracking-wide text-ink-muted uppercase">
              <th className="px-4 py-3 font-medium">Person</th>
              <th className="px-4 py-3 text-right font-medium">Open</th>
              <th className="px-4 py-3 text-right font-medium">Committed</th>
              <th className="px-4 py-3 font-medium">Load</th>
              <th className="px-4 py-3 font-medium">When it&apos;s due</th>
              <th className="px-4 py-3 text-right font-medium">Logged this week</th>
            </tr>
          </thead>
          <tbody>
            {people.map((p) => (
              <tr key={p.id} className="border-b border-line last:border-0">
                <td className="px-4 py-3">
                  <Link
                    href={`/tasks?assigneeId=${p.id}`}
                    className="font-medium text-ink hover:text-accent"
                  >
                    {p.name}
                  </Link>
                  <p className="text-[11px] text-ink-muted">{p.role}</p>
                </td>

                <td className="tabular px-4 py-3 text-right text-ink">
                  {p.summary.openCount}
                  {p.summary.overdueCount > 0 && (
                    <span className="block text-[11px] font-medium text-overdue">
                      {p.summary.overdueCount} overdue
                    </span>
                  )}
                </td>

                <td className="tabular px-4 py-3 text-right text-ink">
                  {p.summary.estimatedCount > 0 ? formatMinutes(p.summary.committedMinutes) : "—"}
                  {/* The honesty column: unknowns are reported as unknowns. */}
                  {p.summary.unestimatedCount > 0 && (
                    <span className="block text-[11px] text-ink-muted">
                      +{p.summary.unestimatedCount} unestimated
                    </span>
                  )}
                </td>

                <td className="px-4 py-3">
                  <LoadCell load={p.load} capacityMinutes={p.capacityMinutes} />
                </td>

                <td className="px-4 py-3">
                  <DueSpread summary={p.summary} />
                </td>

                <td className="tabular px-4 py-3 text-right text-ink-muted">
                  {p.loggedThisWeek > 0 ? formatMinutes(p.loggedThisWeek) : "—"}
                  {p.capacityMinutes && p.loggedThisWeek > 0 && (
                    <span className="block text-[11px] text-ink-muted">
                      of {toDecimalHours(p.capacityMinutes)}h
                    </span>
                  )}
                </td>
              </tr>
            ))}
            {people.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-ink-muted">
                  No employees on file.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const LOAD_TONE: Record<string, string> = {
  unknown: "bg-black/10",
  light: "bg-[var(--status-done)]",
  steady: "bg-accent",
  full: "bg-[var(--status-review)]",
  over: "bg-overdue",
};

function LoadCell({
  load,
  capacityMinutes,
}: {
  load: Load;
  capacityMinutes: number | null;
}) {
  if (load.percent === null) {
    return (
      <span className="text-xs text-ink-muted">
        {capacityMinutes === null ? "No capacity set" : "No estimates"}
      </span>
    );
  }

  return (
    <span className="flex items-center gap-2">
      <span className="h-1.5 w-24 overflow-hidden rounded-full bg-black/5">
        <span
          className={`block h-full rounded-full ${LOAD_TONE[load.level]}`}
          // Over-capacity is reported in the number, but the bar can't be
          // longer than the bar.
          style={{ width: `${Math.min(100, load.percent)}%` }}
        />
      </span>
      <span
        className={`tabular text-xs ${
          load.level === "over"
            ? "font-medium text-overdue"
            : load.level === "full"
              ? "font-medium text-[var(--status-review)]"
              : "text-ink-muted"
        }`}
        title={LOAD_LABELS[load.level]}
      >
        {load.percent}%
      </span>
    </span>
  );
}

function DueSpread({ summary }: { summary: WorkloadSummary }) {
  const parts: { label: string; count: number; tone: string }[] = [
    { label: "overdue", count: summary.buckets.overdue, tone: "text-overdue" },
    { label: "today", count: summary.buckets.today, tone: "text-[var(--status-review)]" },
    { label: "this week", count: summary.buckets.thisWeek, tone: "text-ink" },
    { label: "next week", count: summary.buckets.nextWeek, tone: "text-ink-muted" },
    { label: "later", count: summary.buckets.later, tone: "text-ink-muted" },
    { label: "no date", count: summary.buckets.noDueDate, tone: "text-ink-muted" },
  ].filter((p) => p.count > 0);

  if (parts.length === 0) return <span className="text-xs text-ink-muted">Nothing open</span>;

  return (
    <span className="flex flex-wrap gap-x-2 gap-y-0.5 text-[11px]">
      {parts.map((p) => (
        <span key={p.label} className={p.tone}>
          <span className="tabular font-medium">{p.count}</span> {p.label}
        </span>
      ))}
    </span>
  );
}
