import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/auth";
import { resolveRange, rollUp, type TimeRangeKey, type Rollup } from "@/lib/time";

// Time-tracking reads. Deliberately NOT a "use server" module — these are
// queries called from server components, and marking them as actions would
// publish every one of them as a POST endpoint for no reason. The mutations
// live in src/lib/time-actions.ts.
//
// Visibility follows the same rule as the rest of the app (see assigneeScope
// in src/lib/auth.ts), with one addition that matters: an EMPLOYEE sees only
// their OWN time, and never a money figure. A timesheet is personal data and a
// billing rate is commercially sensitive, so "can see the task" does not imply
// "can see what the firm bills for it".

export type TimeScope = { employeeId: string | null; canSeeMoney: boolean };

export function timeScope(user: CurrentUser): TimeScope {
  return {
    employeeId: user.role === "ADMIN" ? null : user.id,
    canSeeMoney: user.role === "ADMIN",
  };
}

// The one timer currently running for an employee, if any. At most one exists
// — startTimer stops any other before opening a new one — but this reads the
// most recent rather than asserting uniqueness, so a row left behind by a
// crash mid-write shows up instead of throwing on every page load.
export async function runningTimer(employeeId: string) {
  return prisma.timeEntry.findFirst({
    where: { employeeId, endedAt: null },
    orderBy: { startedAt: "desc" },
    include: {
      client: { select: { companyName: true } },
      project: { select: { name: true } },
      activity: { include: { subTask: { select: { name: true } } } },
    },
  });
}

export type TimeEntryRow = Awaited<ReturnType<typeof listTimeEntries>>[number];

export async function listTimeEntries(where: {
  employeeId?: string | null;
  clientId?: string | null;
  projectId?: string | null;
  activityId?: string | null;
  periodName?: string | null;
  range?: { start: Date; end: Date } | null;
  // Running entries are excluded by default: an entry with no end has no
  // duration yet, and including it in a list of logged work would show a 0m
  // row that is actually a clock still ticking.
  includeRunning?: boolean;
  take?: number;
}) {
  return prisma.timeEntry.findMany({
    where: {
      ...(where.employeeId ? { employeeId: where.employeeId } : {}),
      ...(where.clientId ? { clientId: where.clientId } : {}),
      ...(where.projectId ? { projectId: where.projectId } : {}),
      ...(where.activityId ? { activityId: where.activityId } : {}),
      ...(where.periodName ? { periodName: where.periodName } : {}),
      ...(where.includeRunning ? {} : { endedAt: { not: null } }),
      ...(where.range
        ? { startedAt: { gte: where.range.start, lte: where.range.end } }
        : {}),
    },
    include: {
      employee: { select: { id: true, firstName: true, lastName: true } },
      client: { select: { id: true, companyName: true } },
      project: { select: { id: true, name: true } },
      activity: { include: { subTask: { select: { name: true } } } },
    },
    orderBy: [{ startedAt: "desc" }],
    ...(where.take ? { take: where.take } : {}),
  });
}

// --- Rollups -----------------------------------------------------------------

export type GroupedRollup = {
  key: string;
  label: string;
  // A secondary line for the group heading (a client's service, an employee's
  // role) — optional, so a rollup that has nothing extra to say says nothing.
  sublabel?: string | null;
  rollup: Rollup;
};

function group(
  entries: {
    minutes: number;
    billable: boolean;
    rateSnapshot: number | null;
  }[],
  keyOf: (index: number) => { key: string; label: string; sublabel?: string | null }
): GroupedRollup[] {
  const buckets = new Map<string, { label: string; sublabel?: string | null; rows: typeof entries }>();
  entries.forEach((entry, i) => {
    const { key, label, sublabel } = keyOf(i);
    const existing = buckets.get(key);
    if (existing) existing.rows.push(entry);
    else buckets.set(key, { label, sublabel, rows: [entry] });
  });
  return [...buckets.entries()]
    .map(([key, b]) => ({ key, label: b.label, sublabel: b.sublabel, rollup: rollUp(b.rows) }))
    .sort((a, b) => b.rollup.totalMinutes - a.rollup.totalMinutes);
}

// Per-employee and per-client rollups over one range, from a single query. Two
// passes over an array in memory beats two more database round trips at this
// data size, and it guarantees both rollups describe exactly the same set of
// entries — which they would not if each ran its own query.
export async function timeRollups(input: {
  range: TimeRangeKey;
  employeeId?: string | null;
  clientId?: string | null;
  now?: Date;
}): Promise<{
  range: { start: Date; end: Date; label: string };
  total: Rollup;
  byEmployee: GroupedRollup[];
  byClient: GroupedRollup[];
  byProject: GroupedRollup[];
  entries: TimeEntryRow[];
}> {
  const range = resolveRange(input.range, input.now);
  const entries = await listTimeEntries({
    employeeId: input.employeeId ?? null,
    clientId: input.clientId ?? null,
    range,
  });

  const plain = entries.map((e) => ({
    minutes: e.minutes,
    billable: e.billable,
    rateSnapshot: e.rateSnapshot,
  }));

  return {
    range,
    total: rollUp(plain),
    byEmployee: group(plain, (i) => ({
      key: entries[i].employeeId,
      label: `${entries[i].employee.firstName} ${entries[i].employee.lastName}`,
    })),
    // Time with no client attached is real time — internal admin, training —
    // and dropping it would make the rollup disagree with the total, so it
    // gets its own labelled bucket instead.
    byClient: group(plain, (i) => ({
      key: entries[i].clientId ?? "__none",
      label: entries[i].client?.companyName ?? "No client (internal)",
    })),
    byProject: group(plain, (i) => ({
      key: entries[i].projectId ?? "__none",
      label: entries[i].project?.name ?? "No service",
    })),
    entries,
  };
}

// Minutes logged per activity id, for showing "2h 15m logged" against a
// checklist step. Grouped in the database — one row per step beats reading
// every entry back to sum them in JavaScript.
export async function loggedMinutesByActivity(activityIds: string[]): Promise<Map<string, number>> {
  if (activityIds.length === 0) return new Map();
  const rows = await prisma.timeEntry.groupBy({
    by: ["activityId"],
    where: { activityId: { in: activityIds }, endedAt: { not: null } },
    _sum: { minutes: true },
  });
  return new Map(
    rows
      .filter((r): r is typeof r & { activityId: string } => r.activityId !== null)
      .map((r) => [r.activityId, r._sum.minutes ?? 0])
  );
}

// Minutes logged per employee over a range, for the workload view. Same
// reasoning as above: aggregate in the database.
export async function loggedMinutesByEmployee(range: {
  start: Date;
  end: Date;
}): Promise<Map<string, number>> {
  const rows = await prisma.timeEntry.groupBy({
    by: ["employeeId"],
    where: { endedAt: { not: null }, startedAt: { gte: range.start, lte: range.end } },
    _sum: { minutes: true },
  });
  return new Map(rows.map((r) => [r.employeeId, r._sum.minutes ?? 0]));
}
