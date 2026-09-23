import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { timeScope, listTimeEntries, runningTimer } from "@/lib/time-data";
import {
  resolveRange,
  isTimeRange,
  rollUp,
  realizationPercent,
  formatMinutes,
  formatMoney,
  TIME_RANGES,
  TIME_RANGE_LABELS,
  type TimeRangeKey,
} from "@/lib/time";
import { TimeEntryForm } from "@/components/time-entry-form";
import { TimeEntryList, type TimeRow } from "@/components/time-entry-list";
import { ExportBar } from "@/components/export-bar";

// The timesheet.
//
// Scoping is the thing to know: an EMPLOYEE sees only their own time and no
// money at all, an ADMIN sees the firm and the amounts. A timesheet is
// personal data and a billing rate is commercially sensitive, so "can see the
// task" deliberately does not imply "can see what we charge for it" — see
// timeScope() in src/lib/time-data.ts.
export default async function TimePage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string; employeeId?: string; clientId?: string }>;
}) {
  const user = await requireUser();
  const scope = timeScope(user);
  const params = await searchParams;

  const rangeKey: TimeRangeKey = isTimeRange(params.range) ? params.range : "this-week";
  const range = resolveRange(rangeKey);

  // An employee's filter is pinned to themselves, and the picker is hidden —
  // the same pattern /tasks already uses for the assignee chip.
  const employeeFilter = scope.employeeId ?? params.employeeId ?? null;
  const clientFilter = params.clientId ?? null;

  const [entries, running, employees, clients] = await Promise.all([
    listTimeEntries({ employeeId: employeeFilter, clientId: clientFilter, range }),
    runningTimer(user.id),
    scope.employeeId
      ? Promise.resolve([])
      : prisma.employee.findMany({ orderBy: [{ firstName: "asc" }, { lastName: "asc" }] }),
    // Scoped like every other client picker: an employee can only book time
    // to clients they work with (the action refuses anything else), so
    // listing the rest would be both a leak and a trap.
    prisma.client.findMany({
      where: {
        archivedAt: null,
        ...(user.role === "ADMIN" ? {} : { activities: { some: { assigneeId: user.id } } }),
      },
      orderBy: { companyName: "asc" },
    }),
  ]);

  const rollup = rollUp(
    entries.map((e) => ({
      minutes: e.minutes,
      billable: e.billable,
      rateSnapshot: e.rateSnapshot,
    }))
  );
  const realization = realizationPercent(rollup);

  const rows: TimeRow[] = entries.map((e) => ({
    id: e.id,
    startedAt: e.startedAt.toISOString(),
    employeeName: `${e.employee.firstName} ${e.employee.lastName}`,
    clientName: e.client?.companyName ?? null,
    projectName: e.project?.name ?? null,
    taskName: e.activity?.subTask.name ?? null,
    minutes: e.minutes,
    billable: e.billable,
    source: e.source,
    note: e.note,
    // The rate is nulled out for a non-admin so the amount can't be
    // reconstructed in the browser from data that was sent anyway.
    rateSnapshot: scope.canSeeMoney ? e.rateSnapshot : null,
    editable: e.employeeId === user.id || user.role === "ADMIN",
    href:
      e.clientId && e.projectId ? `/assignments/${e.clientId}/${e.projectId}` : null,
  }));

  const keep = (extra: Record<string, string | null>) => {
    const next = new URLSearchParams();
    if (rangeKey !== "this-week") next.set("range", rangeKey);
    if (params.employeeId && !scope.employeeId) next.set("employeeId", params.employeeId);
    if (params.clientId) next.set("clientId", params.clientId);
    for (const [k, v] of Object.entries(extra)) {
      if (v === null) next.delete(k);
      else next.set(k, v);
    }
    const q = next.toString();
    return q ? `/time?${q}` : "/time";
  };

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-10">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Time</h1>
          <p className="mt-1 text-sm text-ink-muted">
            {scope.employeeId
              ? "Your timesheet. Start a timer from any checklist step, or log time here."
              : "Every hour logged across the firm. Start a timer from a checklist step, or log time here."}
          </p>
        </div>
        <ExportBar
          reportKey="time-entries"
          query={{
            range: rangeKey,
            employeeId: scope.employeeId ? null : params.employeeId,
            clientId: params.clientId,
          }}
        />
      </div>

      {running && (
        <div className="mt-4 rounded-lg border border-[var(--status-done)]/30 bg-[var(--status-done-soft)] px-4 py-3 text-sm text-[var(--status-done)]">
          A timer is running on{" "}
          <span className="font-medium">
            {running.activity?.subTask.name ?? running.project?.name ?? "something"}
          </span>
          . Stop it from the sidebar, or from the step itself.
        </div>
      )}

      {/* Range chips. URL-driven, like every other filter in the app, so a
          view is linkable and survives a refresh. */}
      <div className="no-print mt-5 flex flex-wrap items-center gap-1.5">
        {TIME_RANGES.map((key) => (
          <Link
            key={key}
            href={keep({ range: key === "this-week" ? null : key })}
            aria-current={key === rangeKey ? "page" : undefined}
            className={`rounded-full border px-3 py-1 text-xs transition-colors ${
              key === rangeKey
                ? "border-accent bg-accent-soft text-accent"
                : "border-line text-ink-muted hover:border-ink-muted/40 hover:text-ink"
            }`}
          >
            {TIME_RANGE_LABELS[key]}
          </Link>
        ))}

        {!scope.employeeId && (
          <form action="/time" className="ml-2 flex items-center gap-1.5">
            {rangeKey !== "this-week" && <input type="hidden" name="range" value={rangeKey} />}
            <select
              name="employeeId"
              defaultValue={params.employeeId ?? ""}
              className="rounded-full border border-line bg-surface px-3 py-1 text-xs text-ink focus:ring-2 focus:ring-accent/40 focus:outline-none"
            >
              <option value="">Everyone</option>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.firstName} {e.lastName}
                </option>
              ))}
            </select>
            <select
              name="clientId"
              defaultValue={params.clientId ?? ""}
              className="rounded-full border border-line bg-surface px-3 py-1 text-xs text-ink focus:ring-2 focus:ring-accent/40 focus:outline-none"
            >
              <option value="">All clients</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.companyName}
                </option>
              ))}
            </select>
            <button
              type="submit"
              className="rounded-full border border-line bg-surface px-3 py-1 text-xs font-medium text-ink hover:bg-black/5"
            >
              Apply
            </button>
          </form>
        )}
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label={`Total · ${range.label}`} value={formatMinutes(rollup.totalMinutes)} />
        <Stat label="Billable" value={formatMinutes(rollup.billableMinutes)} />
        <Stat
          label="Realization"
          // Null for an empty range: 0/0 is not 0%, and "0% realization"
          // against a week with no time reads as a problem rather than an
          // absence of data.
          value={realization === null ? "—" : `${realization}%`}
          hint={realization === null ? "Nothing logged yet" : undefined}
        />
        {scope.canSeeMoney && (
          <Stat
            label="Value"
            value={formatMoney(rollup.amount)}
            hint={
              rollup.amount === null
                ? "No billing rates set"
                : rollup.ratedMinutes < rollup.totalMinutes
                  ? `Covers ${formatMinutes(rollup.ratedMinutes)} of ${formatMinutes(rollup.totalMinutes)} — the rest has no rate`
                  : undefined
            }
          />
        )}
      </div>

      <div className="mt-6">
        <TimeEntryForm
          clients={clients.map((c) => ({ id: c.id, name: c.companyName }))}
          employees={employees.map((e) => ({
            id: e.id,
            name: `${e.firstName} ${e.lastName}`,
          }))}
          canLogForOthers={user.role === "ADMIN"}
          currentEmployeeId={user.id}
        />
      </div>

      <div className="mt-6">
        <TimeEntryList
          entries={rows}
          showEmployee={!scope.employeeId}
          showMoney={scope.canSeeMoney}
          emptyMessage={`No time logged in ${range.label.toLowerCase()}.`}
        />
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="print-block rounded-lg border border-line bg-surface p-4">
      <p className="text-xs tracking-wide text-ink-muted uppercase">{label}</p>
      <p className="tabular mt-1.5 text-xl font-semibold text-ink">{value}</p>
      {hint && <p className="mt-1 text-[11px] text-ink-muted">{hint}</p>}
    </div>
  );
}
