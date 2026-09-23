// The pure functions the whole app's correctness rests on: sequential
// completion, an engagement's derived status, the dashboard's due buckets, and
// the period arithmetic behind rollover and the scheduler. No framework, no
// database — run it with:
//
//   ./node_modules/.bin/tsx scripts/test-core-rules.ts
import { canMarkDone, deriveAssignmentStatus, progressLabel } from "../src/lib/workflow";
import { dueBucket, matchesDueFilter, dueDateUrgency } from "../src/lib/dates";
import {
  currentPeriodName,
  nextPeriodName,
  periodRangeForName,
  isPeriodBefore,
} from "../src/lib/period-names";
import { isAllowed, DENIED } from "../src/lib/permissions";
import { check, section, finish } from "./harness";

type Status = "NOT_STARTED" | "IN_PROGRESS" | "AWAITING_REVIEW" | "DONE";
const step = (taskSeqNo: number, status: Status) => ({ taskSeqNo, status });

// --- canMarkDone ---------------------------------------------------------------

section("canMarkDone — sequential completion");
{
  const checklist = [step(10, "DONE"), step(20, "IN_PROGRESS"), step(30, "NOT_STARTED")];
  check("the first open step can be finished", canMarkDone(checklist[1], checklist), true);
  check("a step after an open one cannot", canMarkDone(checklist[2], checklist), false);
  check("the very first step is never blocked", canMarkDone(step(10, "NOT_STARTED"), [step(10, "NOT_STARTED"), step(20, "NOT_STARTED")]), true);
  check(
    "later open steps don't block an earlier one",
    canMarkDone(step(10, "IN_PROGRESS"), [step(10, "IN_PROGRESS"), step(20, "IN_PROGRESS")]),
    true
  );
  check(
    "AWAITING_REVIEW is still open, so it blocks",
    canMarkDone(step(20, "NOT_STARTED"), [step(10, "AWAITING_REVIEW"), step(20, "NOT_STARTED")]),
    false
  );
  check(
    "order of the siblings array doesn't matter",
    canMarkDone(step(30, "NOT_STARTED"), [step(30, "NOT_STARTED"), step(10, "DONE"), step(20, "DONE")]),
    true
  );
  check(
    "gaps in sequence numbers (10, 42, 50) are fine",
    canMarkDone(step(50, "NOT_STARTED"), [step(10, "DONE"), step(42, "NOT_STARTED"), step(50, "NOT_STARTED")]),
    false
  );
  check("a lone step with no siblings passes", canMarkDone(step(10, "NOT_STARTED"), []), true);
  check(
    "re-marking an already-done step is allowed when earlier ones are done",
    canMarkDone(step(20, "DONE"), [step(10, "DONE"), step(20, "DONE")]),
    true
  );
}

// --- deriveAssignmentStatus / progressLabel -----------------------------------

section("deriveAssignmentStatus");
check("no steps → not started", deriveAssignmentStatus([]), "NOT_STARTED");
check("all done → done", deriveAssignmentStatus([step(10, "DONE"), step(20, "DONE")]), "DONE");
check(
  "takes the status of the first incomplete step",
  deriveAssignmentStatus([step(10, "DONE"), step(20, "AWAITING_REVIEW"), step(30, "IN_PROGRESS")]),
  "AWAITING_REVIEW"
);
check(
  "sorts by sequence rather than trusting input order",
  deriveAssignmentStatus([step(30, "IN_PROGRESS"), step(20, "NOT_STARTED"), step(10, "DONE")]),
  "NOT_STARTED"
);

section("progressLabel");
check("counts done over total", progressLabel([step(10, "DONE"), step(20, "IN_PROGRESS"), step(30, "DONE")]), "2/3");
check("empty checklist", progressLabel([]), "0/0");

// --- dueBucket -----------------------------------------------------------------

section("dueBucket — weekday (Wednesday 23 Sep 2026)");
{
  const wed = new Date(2026, 8, 23, 14, 30);
  const d = (m: number, day: number, h = 12) => new Date(2026, m, day, h);
  check("yesterday → overdue", dueBucket(d(8, 22), "IN_PROGRESS", wed), "overdue");
  check("today (morning) → today", dueBucket(d(8, 23, 0), "IN_PROGRESS", wed), "today");
  check("today (late evening) → today", dueBucket(d(8, 23, 23), "IN_PROGRESS", wed), "today");
  check("Thursday → this week", dueBucket(d(8, 24), "NOT_STARTED", wed), "this-week");
  check("Sunday → still this week", dueBucket(d(8, 27), "NOT_STARTED", wed), "this-week");
  check("Monday → next week", dueBucket(d(8, 28), "NOT_STARTED", wed), "next-week");
  check("next Sunday → next week", dueBucket(d(9, 4), "NOT_STARTED", wed), "next-week");
  check("the Monday after → later", dueBucket(d(9, 5), "NOT_STARTED", wed), "later");
  check("done work is outside every bucket", dueBucket(d(8, 22), "DONE", wed), "none");
  check("no date is outside every bucket", dueBucket(null, "NOT_STARTED", wed), "none");
}

section("dueBucket — Sunday is the last day of the week");
{
  const sun = new Date(2026, 8, 27, 9);
  check("Sunday itself → today", dueBucket(new Date(2026, 8, 27, 18), "NOT_STARTED", sun), "today");
  check("Monday → next week, not this week", dueBucket(new Date(2026, 8, 28), "NOT_STARTED", sun), "next-week");
  check("following Sunday → next week", dueBucket(new Date(2026, 9, 4), "NOT_STARTED", sun), "next-week");
  check("the Monday after → later", dueBucket(new Date(2026, 9, 5), "NOT_STARTED", sun), "later");
}

section("dueBucket — Monday is the first day of the week");
{
  const mon = new Date(2026, 8, 21, 9);
  check("Sunday of the same week → this week", dueBucket(new Date(2026, 8, 27), "NOT_STARTED", mon), "this-week");
  check("the next Monday → next week", dueBucket(new Date(2026, 8, 28), "NOT_STARTED", mon), "next-week");
}

section("dueBucket — across month and year boundaries");
{
  const dec30 = new Date(2026, 11, 30, 9); // a Wednesday
  check("Jan 1 → this week", dueBucket(new Date(2027, 0, 1), "NOT_STARTED", dec30), "this-week");
  check("Jan 4 (Mon) → next week", dueBucket(new Date(2027, 0, 4), "NOT_STARTED", dec30), "next-week");
  check("Dec 29 → overdue", dueBucket(new Date(2026, 11, 29), "NOT_STARTED", dec30), "overdue");
}

section("matchesDueFilter");
check("this-week includes today", matchesDueFilter("today", "this-week"), true);
check("this-week includes this-week", matchesDueFilter("this-week", "this-week"), true);
check("today excludes the rest of the week", matchesDueFilter("this-week", "today"), false);
check("overdue only matches overdue", matchesDueFilter("today", "overdue"), false);
check("next-week matches next-week", matchesDueFilter("next-week", "next-week"), true);
check("later matches no filter", ["today", "this-week", "next-week", "overdue"].some((f) => matchesDueFilter("later", f as "today")), false);

section("dueDateUrgency");
{
  const now = new Date();
  const inDays = (n: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + n, 12);
  check("past → overdue", dueDateUrgency(inDays(-1), "IN_PROGRESS"), "overdue");
  check("within two days → soon", dueDateUrgency(inDays(2), "IN_PROGRESS"), "soon");
  check("three days out → normal", dueDateUrgency(inDays(3), "IN_PROGRESS"), "normal");
  check("done is never urgent", dueDateUrgency(inDays(-5), "DONE"), "normal");
}

// --- Periods -------------------------------------------------------------------

section("nextPeriodName");
check("monthly: mid-year", nextPeriodName("MONTHLY", "2026-08"), "2026-09");
check("monthly: December rolls into January", nextPeriodName("MONTHLY", "2026-12"), "2027-01");
check("monthly: keeps zero padding", nextPeriodName("MONTHLY", "2026-01"), "2026-02");
check("quarterly: Q1 → Q2", nextPeriodName("QUARTERLY", "2026-Q1"), "2026-Q2");
check("quarterly: Q4 rolls into next year", nextPeriodName("QUARTERLY", "2026-Q4"), "2027-Q1");
check("annual", nextPeriodName("ANNUAL", "2026"), "2027");
check("one-time has no next period", nextPeriodName("ONE_TIME", "ONE-TIME"), null);
{
  // Walking a year of months forward must land exactly twelve months later —
  // this is what the scheduler does for an engagement that fell behind.
  let name = "2026-03";
  for (let i = 0; i < 12; i += 1) name = nextPeriodName("MONTHLY", name)!;
  check("twelve monthly steps = one year", name, "2027-03");
  let q = "2025-Q3";
  for (let i = 0; i < 4; i += 1) q = nextPeriodName("QUARTERLY", q)!;
  check("four quarterly steps = one year", q, "2026-Q3");
}

section("currentPeriodName");
check("monthly", currentPeriodName("MONTHLY", new Date(2026, 0, 15)), "2026-01");
check("quarterly: 31 Mar is Q1", currentPeriodName("QUARTERLY", new Date(2026, 2, 31)), "2026-Q1");
check("quarterly: 1 Apr is Q2", currentPeriodName("QUARTERLY", new Date(2026, 3, 1)), "2026-Q2");
check("quarterly: December is Q4", currentPeriodName("QUARTERLY", new Date(2026, 11, 31)), "2026-Q4");
check("annual", currentPeriodName("ANNUAL", new Date(2026, 5, 1)), "2026");
check("one-time", currentPeriodName("ONE_TIME", new Date()), "ONE-TIME");
check(
  "next(current) is consistent with current(one month later)",
  nextPeriodName("MONTHLY", currentPeriodName("MONTHLY", new Date(2026, 10, 30))),
  currentPeriodName("MONTHLY", new Date(2026, 11, 1))
);

section("periodRangeForName");
{
  const ymd = (d: Date) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  const feb = periodRangeForName("MONTHLY", "2024-02");
  check("leap-year February ends on the 29th", ymd(feb.end), "2024-2-29");
  check("non-leap February ends on the 28th", ymd(periodRangeForName("MONTHLY", "2026-02").end), "2026-2-28");
  const q4 = periodRangeForName("QUARTERLY", "2026-Q4");
  check("Q4 starts 1 Oct", ymd(q4.start), "2026-10-1");
  check("Q4 ends 31 Dec", ymd(q4.end), "2026-12-31");
  const year = periodRangeForName("ANNUAL", "2026");
  check("a year runs 1 Jan – 31 Dec", [ymd(year.start), ymd(year.end)], ["2026-1-1", "2026-12-31"]);
}

section("isPeriodBefore");
check("numeric, not text, order: 2026-9 < 2026-10", isPeriodBefore("MONTHLY", "2026-9", "2026-10"), true);
check("…and not the other way round", isPeriodBefore("MONTHLY", "2026-10", "2026-9"), false);
check("a period is not before itself", isPeriodBefore("MONTHLY", "2026-10", "2026-10"), false);
check("across a year boundary", isPeriodBefore("QUARTERLY", "2026-Q4", "2027-Q1"), true);
check("a malformed name never compares as before", isPeriodBefore("MONTHLY", "garbage", "2026-10"), false);

// --- Permissions -----------------------------------------------------------------

section("permissions");
check("admin can do firm-structure changes", isAllowed("admin", { role: "ADMIN" }), true);
check("employee cannot", isAllowed("admin", { role: "EMPLOYEE", onEngagement: true, onClient: true }), false);
check("admin can work any engagement", isAllowed("engagement", { role: "ADMIN" }), true);
check("employee on the engagement can work it", isAllowed("engagement", { role: "EMPLOYEE", onEngagement: true }), true);
check("employee off the engagement cannot", isAllowed("engagement", { role: "EMPLOYEE", onEngagement: false }), false);
check(
  "being on another of the client's engagements is not enough for this one",
  isAllowed("engagement", { role: "EMPLOYEE", onEngagement: false, onClient: true }),
  false
);
check("employee with no facts is refused", isAllowed("engagement", { role: "EMPLOYEE" }), false);
check("employee on the client can edit it", isAllowed("client", { role: "EMPLOYEE", onClient: true }), true);
check("on an engagement implies on the client", isAllowed("client", { role: "EMPLOYEE", onEngagement: true }), true);
check("employee off the client cannot edit it", isAllowed("client", { role: "EMPLOYEE", onClient: false }), false);
check(
  "the refusal doesn't say whether the record exists",
  /doesn't exist or/.test(DENIED.engagement) && /doesn't exist or/.test(DENIED.client),
  true
);

finish();
