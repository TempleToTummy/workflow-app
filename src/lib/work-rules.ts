import type { ActivityStatus } from "@prisma/client";

// The pure half of src/lib/work-summary.ts: value normalisation, the status
// rule and the current-period matching, with no database client, so
// scripts/test-work-summary.ts covers them directly. Also the page arithmetic
// the long lists share (src/components/pager.tsx renders it).

// Just what summaryStatus needs from a PeriodSummary (src/lib/work-summary.ts).
type StatusFacts = { total: number; done: number; repStatus: ActivityStatus };

export type Engagement = { clientId: string; projectId: string; currentPeriod: string | null };

// Raw SQL values differ by database: SQLite hands back BigInt for counts and
// epoch milliseconds (as BigInt) for DateTime columns, Postgres hands back
// BigInt counts and Date objects. These accept either.
export function rawNumber(value: unknown): number {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value);
  return 0;
}

export function rawDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  if (typeof value === "bigint") return new Date(Number(value));
  if (typeof value === "number" || typeof value === "string") {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

// The status a whole period shows. Matches deriveAssignmentStatus: DONE only
// when every step is done, otherwise whatever the first open step is doing.
export function summaryStatus(s: StatusFacts): ActivityStatus {
  if (s.total === 0) return "NOT_STARTED";
  if (s.done === s.total) return "DONE";
  return s.repStatus;
}

export const engagementKey = (clientId: string, projectId: string, periodName: string) =>
  `${clientId}:${projectId}:${periodName}`;

// Buckets rows under the engagement they belong to, keeping only rows in that
// engagement's CURRENT period. Pure, so the matching rule is testable.
export function groupByCurrentPeriod<R extends { clientId: string; projectId: string; periodName: string }>(
  engagements: Engagement[],
  rows: R[]
): Map<string, R[]> {
  const out = new Map<string, R[]>();
  for (const e of engagements) {
    if (e.currentPeriod) out.set(engagementKey(e.clientId, e.projectId, e.currentPeriod), []);
  }
  for (const r of rows) {
    out.get(engagementKey(r.clientId, r.projectId, r.periodName))?.push(r);
  }
  return out;
}

// The distinct current period names across a set of engagements. There are
// only a handful at any time (this month, this quarter, this year, a few
// laggards), which is what makes `periodName IN (...)` a tight filter.
export function currentPeriodNames(engagements: Engagement[]): string[] {
  return [...new Set(engagements.map((e) => e.currentPeriod).filter((p): p is string => !!p))];
}

// --- Paging --------------------------------------------------------------------------

export const PAGE_SIZE = 100;

// The page asked for in ?page, clamped to the pages that exist, so a stale or
// hand-typed link shows the last page rather than an empty one.
export function pageFromParams(value: string | undefined, total: number, pageSize = PAGE_SIZE): number {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, pageCount);
}
