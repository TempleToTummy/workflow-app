// The pure rules behind the fast read paths (src/lib/work-summary.ts): raw SQL
// value handling for both databases, the period status rule, current-period
// matching and paging. No database:
//
//   ./node_modules/.bin/tsx scripts/test-work-summary.ts
import {
  rawNumber,
  rawDate,
  summaryStatus,
  groupByCurrentPeriod,
  currentPeriodNames,
  pageFromParams,
  PAGE_SIZE,
} from "../src/lib/work-rules";
import { deriveAssignmentStatus } from "../src/lib/workflow";
import { check, section, finish } from "./harness";
import type { ActivityStatus } from "@prisma/client";

section("raw values from SQLite and Postgres");
{
  check("SQLite count (BigInt)", rawNumber(BigInt(9)), 9);
  check("plain number", rawNumber(4), 4);
  check("numeric string", rawNumber("12"), 12);
  check("null count", rawNumber(null), 0);
  const ms = Date.UTC(2026, 8, 30);
  check("SQLite date (BigInt epoch ms)", rawDate(BigInt(ms))?.getTime(), ms);
  check("Postgres date (Date)", rawDate(new Date(ms))?.getTime(), ms);
  check("ISO string", rawDate("2026-09-30T00:00:00.000Z")?.getTime(), ms);
  check("null date", rawDate(null), null);
  check("garbage date", rawDate("not a date"), null);
}

section("summaryStatus matches deriveAssignmentStatus");
{
  // Every combination of up to three steps: the SQL summary (counts plus the
  // first open step, or the last step when all are done) must agree with the
  // rule the checklist itself uses.
  const statuses: ActivityStatus[] = ["NOT_STARTED", "IN_PROGRESS", "AWAITING_REVIEW", "DONE"];
  let disagreements = 0;
  const combos: ActivityStatus[][] = [[]];
  for (let n = 1; n <= 3; n++) {
    const next: ActivityStatus[][] = [];
    for (const c of combos.filter((c) => c.length === n - 1)) for (const s of statuses) next.push([...c, s]);
    combos.push(...next);
  }
  for (const combo of combos) {
    const acts = combo.map((status, i) => ({ status, taskSeqNo: (i + 1) * 10 }));
    const open = acts.filter((a) => a.status !== "DONE");
    const rep = open.length ? open[0] : acts[acts.length - 1];
    const summary = {
      total: acts.length,
      done: acts.length - open.length,
      repStatus: rep?.status ?? "NOT_STARTED",
    };
    if (summaryStatus(summary) !== deriveAssignmentStatus(acts)) disagreements += 1;
  }
  check(`all ${combos.length} step combinations agree`, disagreements, 0);
  check("no steps", summaryStatus({ total: 0, done: 0, repStatus: "DONE" }), "NOT_STARTED");
}

section("current-period matching");
{
  const engagements = [
    { clientId: "c1", projectId: "p1", currentPeriod: "2026-09" },
    { clientId: "c2", projectId: "p1", currentPeriod: "2026-Q3" },
    { clientId: "c3", projectId: "p1", currentPeriod: null },
  ];
  const rows = [
    { clientId: "c1", projectId: "p1", periodName: "2026-09", id: 1 },
    { clientId: "c1", projectId: "p1", periodName: "2026-08", id: 2 }, // an old period
    { clientId: "c2", projectId: "p1", periodName: "2026-09", id: 3 }, // someone else's current period
    { clientId: "c2", projectId: "p1", periodName: "2026-Q3", id: 4 },
    { clientId: "c9", projectId: "p1", periodName: "2026-09", id: 5 }, // no engagement
  ];
  const grouped = groupByCurrentPeriod(engagements, rows);
  check("only each engagement's own current period", [...grouped.entries()].map(([k, v]) => [k, v.map((r) => r.id)]), [
    ["c1:p1:2026-09", [1]],
    ["c2:p1:2026-Q3", [4]],
  ]);
  check("distinct current period names", currentPeriodNames(engagements), ["2026-09", "2026-Q3"]);
}

section("paging");
{
  check("default page", pageFromParams(undefined, 1000), 1);
  check("page in range", pageFromParams("3", 1000), 3);
  check("past the end clamps to the last page", pageFromParams("99", 250), 3);
  check("garbage", pageFromParams("abc", 1000), 1);
  check("zero / negative", [pageFromParams("0", 1000), pageFromParams("-2", 1000)], [1, 1]);
  check("empty list still has page 1", pageFromParams("5", 0), 1);
  check("custom page size", pageFromParams("9", 1000, 250), 4);
  check("page size", PAGE_SIZE, 100);
}

finish();
