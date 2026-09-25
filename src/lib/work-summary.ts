import { Prisma, type ActivityStatus, type PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  currentPeriodNames,
  engagementKey,
  groupByCurrentPeriod,
  rawDate,
  rawNumber,
  type Engagement,
} from "@/lib/work-rules";

export { summaryStatus, engagementKey, currentPeriodNames, groupByCurrentPeriod } from "@/lib/work-rules";

// Read paths for the pages that look across ALL work: the dashboard, the task
// list and the status reports.
//
// Those pages used to load every ClientActivity row (with its client, project,
// step and assignee attached) and then filter in JavaScript. That was fine for
// a seeded database; with the real KTAX history (~100k task rows) it made the
// dashboard take half a minute and some reports over a minute, most of it the
// ORM materializing rows nobody looks at. The two functions here ask the
// database for what the page actually shows instead.

// --- Per-period summaries (the dashboard) -----------------------------------------

// One dashboard row's worth of facts about a client + project + period,
// computed in the database. "rep" is the step that decides the row's status
// and assignee, exactly as deriveAssignmentStatus does it in src/lib/workflow.ts:
// the first step that isn't done (lowest taskSeqNo), or when every step is
// done, the last one.
export type PeriodSummary = {
  clientId: string;
  projectId: string;
  periodName: string;
  total: number;
  done: number;
  repStatus: ActivityStatus;
  repAssigneeId: string | null;
  // Earliest due date among steps still open; latest due date overall.
  openDue: Date | null;
  lastDue: Date | null;
  // At least one step is assigned to the `mine` employee passed in.
  hasMine: boolean;
};

// Every client + project + period that has task rows, for clients that aren't
// archived. One query, one row per period (~17k for the KTAX history), no
// matter how many steps each period has.
//
// Written in the SQL that SQLite and Postgres share (quoted identifiers,
// window functions), because the app is moving to Supabase. The window picks
// the representative step with ROW_NUMBER: open steps first, lowest sequence
// first; when none are open, the highest sequence.
export async function periodSummaries(
  options: { mine?: string | null } = {},
  // Overridable so the query can be checked against another database.
  db: Pick<PrismaClient, "$queryRaw"> = prisma
): Promise<PeriodSummary[]> {
  const mine = options.mine ?? "";
  const rows = await db.$queryRaw<Record<string, unknown>[]>(Prisma.sql`
    SELECT "clientId", "projectId", "periodName", "status", "assigneeId",
           "total", "done", "openDue", "lastDue", "mineHits"
    FROM (
      SELECT a."clientId", a."projectId", a."periodName", a."status", a."assigneeId",
        ROW_NUMBER() OVER (
          PARTITION BY a."clientId", a."projectId", a."periodName"
          ORDER BY CASE WHEN a."status" = 'DONE' THEN 1 ELSE 0 END,
                   CASE WHEN a."status" = 'DONE' THEN -a."taskSeqNo" ELSE a."taskSeqNo" END,
                   a."id"
        ) AS "rn",
        COUNT(*) OVER w AS "total",
        SUM(CASE WHEN a."status" = 'DONE' THEN 1 ELSE 0 END) OVER w AS "done",
        MIN(CASE WHEN a."status" <> 'DONE' THEN a."dueDate" END) OVER w AS "openDue",
        MAX(a."dueDate") OVER w AS "lastDue",
        SUM(CASE WHEN a."assigneeId" = ${mine} THEN 1 ELSE 0 END) OVER w AS "mineHits"
      FROM "ClientActivity" a
      JOIN "Client" c ON c."id" = a."clientId"
      WHERE c."archivedAt" IS NULL
      WINDOW w AS (PARTITION BY a."clientId", a."projectId", a."periodName")
    ) ranked
    WHERE "rn" = 1
  `);
  return rows.map((r) => ({
    clientId: String(r.clientId),
    projectId: String(r.projectId),
    periodName: String(r.periodName),
    total: rawNumber(r.total),
    done: rawNumber(r.done),
    repStatus: String(r.status) as ActivityStatus,
    repAssigneeId: r.assigneeId === null || r.assigneeId === undefined ? null : String(r.assigneeId),
    openDue: rawDate(r.openDue),
    lastDue: rawDate(r.lastDue),
    hasMine: rawNumber(r.mineHits) > 0,
  }));
}

// --- Current-period work (task list and reports) -------------------------------------

// Each engagement's current-period task rows, with just the fields the status
// reports use. Replaces a filter over every task row per engagement, which is
// what made those reports quadratic.
export async function currentPeriodWork(engagements: Engagement[]) {
  const rows = await prisma.clientActivity.findMany({
    where: { periodName: { in: currentPeriodNames(engagements) }, client: { archivedAt: null } },
    select: { clientId: true, projectId: true, periodName: true, status: true, taskSeqNo: true },
  });
  const byKey = groupByCurrentPeriod(engagements, rows);
  return (e: Engagement) =>
    e.currentPeriod ? byKey.get(engagementKey(e.clientId, e.projectId, e.currentPeriod)) ?? [] : [];
}
