// Recurrence: the new cadences, start dates, and the due-date question.
// No framework, no database:
//
//   ./node_modules/.bin/tsx scripts/test-recurrence.ts
import {
  currentPeriodName,
  firstPeriodName,
  nextPeriodName,
  parsePeriodName,
  periodNameForRange,
  formatPeriodName,
  checkAnchor,
  effectiveAnchor,
  isPeriodBefore,
  describeSchedule,
} from "../src/lib/period-names";
import { describeRecurrenceVsDue, engagementDueDate } from "../src/lib/due-dates";
import type { RecurringType } from "@prisma/client";
import { periodsInPlay, canMarkDone } from "../src/lib/workflow";
import { check, section, finish } from "./harness";

const d = (y: number, m: number, day: number) => new Date(y, m - 1, day);
const ymd = (x: Date) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
const range = (name: string) => {
  const r = parsePeriodName(name);
  return `${ymd(r.start)} → ${ymd(r.end)}`;
};
const walk = (type: RecurringType, from: string, n: number, anchor?: Date | null) => {
  const out = [from];
  while (out.length < n) out.push(nextPeriodName(type, out[out.length - 1], anchor)!);
  return out;
};

section("names round-trip");
for (const name of ["2026-08", "2026-Q3", "2026-H2", "2026", "2026-10-12..2026-10-18"]) {
  check(`${name}`, periodNameForRange(parsePeriodName(name)), name);
}
check("a range that is a calendar month is named as one", periodNameForRange({ start: d(2026, 2, 1), end: d(2026, 2, 28) }), "2026-02");
check("an impossible date is rejected", (() => { try { parsePeriodName("2026-02-30..2026-03-05"); return "parsed"; } catch { return "rejected"; } })(), "rejected");

section("weekly");
check("default weeks start Monday", range(currentPeriodName("WEEKLY", d(2026, 10, 14))), "2026-10-12 → 2026-10-18");
check("anchored on a Wednesday", range(currentPeriodName("WEEKLY", d(2026, 10, 14), d(2026, 1, 7))), "2026-10-14 → 2026-10-20");
check("next week", walk("WEEKLY", currentPeriodName("WEEKLY", d(2026, 10, 14)), 3).map(formatPeriodName), [
  "Oct 12 – 18, 2026",
  "Oct 19 – 25, 2026",
  "Oct 26 – Nov 1, 2026",
]);
check("across the new year", nextPeriodName("WEEKLY", "2026-12-28..2027-01-03"), "2027-01-04..2027-01-10");

section("every 2 weeks");
{
  const payday = d(2026, 1, 2); // a Friday
  const now = currentPeriodName("BIWEEKLY", d(2026, 10, 14), payday);
  check("aligned to the anchor's two-week cycle", range(now), "2026-10-09 → 2026-10-22");
  check("periods are 14 days", walk("BIWEEKLY", now, 3, payday).map(range), [
    "2026-10-09 → 2026-10-22",
    "2026-10-23 → 2026-11-05",
    "2026-11-06 → 2026-11-19",
  ]);
  check("a date before the anchor still lands on the cycle", range(currentPeriodName("BIWEEKLY", d(2025, 12, 25), payday)), "2025-12-19 → 2026-01-01");
}

section("twice a month");
check("1st–15th", range(currentPeriodName("SEMI_MONTHLY", d(2026, 10, 15))), "2026-10-01 → 2026-10-15");
check("16th–end", range(currentPeriodName("SEMI_MONTHLY", d(2026, 10, 16))), "2026-10-16 → 2026-10-31");
check("February's second half ends on the 28th", range(currentPeriodName("SEMI_MONTHLY", d(2026, 2, 20))), "2026-02-16 → 2026-02-28");
check("…and the 29th in a leap year", range(currentPeriodName("SEMI_MONTHLY", d(2028, 2, 20))), "2028-02-16 → 2028-02-29");
check("walks half by half", walk("SEMI_MONTHLY", "2026-12-16..2026-12-31", 3), [
  "2026-12-16..2026-12-31",
  "2027-01-01..2027-01-15",
  "2027-01-16..2027-01-31",
]);

section("every 6 months");
check("calendar halves by default", currentPeriodName("SEMI_ANNUAL", d(2026, 10, 14)), "2026-H2");
check("H2 → next year's H1", nextPeriodName("SEMI_ANNUAL", "2026-H2"), "2027-H1");
check("anchored on Mar 1", range(currentPeriodName("SEMI_ANNUAL", d(2026, 10, 14), d(2020, 3, 1))), "2026-09-01 → 2027-02-28");

section("start dates on the calendar cadences");
check("monthly from the 15th", range(currentPeriodName("MONTHLY", d(2026, 10, 14), d(2026, 1, 15))), "2026-09-15 → 2026-10-14");
check("…next one", range(nextPeriodName("MONTHLY", currentPeriodName("MONTHLY", d(2026, 10, 14), d(2026, 1, 15)), d(2026, 1, 15))!), "2026-10-15 → 2026-11-14");
check("monthly from the 1st is still named 2026-10", currentPeriodName("MONTHLY", d(2026, 10, 14), d(2025, 6, 1)), "2026-10");
check("fiscal year from Jul 1", range(currentPeriodName("ANNUAL", d(2026, 10, 14), d(2019, 7, 1))), "2026-07-01 → 2027-06-30");
check("fiscal quarters from Feb 1", range(currentPeriodName("QUARTERLY", d(2026, 10, 14), d(2026, 2, 1))), "2026-08-01 → 2026-10-31");
check("day 29–31 can't anchor a monthly schedule", checkAnchor("MONTHLY", d(2026, 1, 31)).ok, false);
check("…but can anchor a weekly one", checkAnchor("WEEKLY", d(2026, 1, 31)).ok, true);
check("client override wins", ymd(effectiveAnchor(d(2026, 1, 1), d(2026, 7, 1))!), "2026-07-01");
check("project anchor otherwise", ymd(effectiveAnchor(d(2026, 1, 1), null)!), "2026-01-01");
check("none → calendar default", effectiveAnchor(null, null), null);

section("first period of a new engagement");
check("today's period when the start date has passed", firstPeriodName("MONTHLY", d(2026, 10, 14), d(2026, 1, 1)), "2026-10");
check("the start date's period when it's in the future", firstPeriodName("BIWEEKLY", d(2026, 10, 14), d(2026, 11, 6)), "2026-11-06..2026-11-19");
check("no start date → today's period", firstPeriodName("WEEKLY", d(2026, 10, 14)), "2026-10-12..2026-10-18");

section("changing the start date mid-stream");
// Running monthly on the 1st, then the client's start date moves to the 15th.
// October finishes as it was; one bridging period lines up with the new
// schedule; from then on it's 15th to 14th. No day skipped, none doubled.
check("bridges to the new schedule", walk("MONTHLY", "2026-10", 4, d(2026, 1, 15)).map(range), [
  "2026-10-01 → 2026-10-31",
  "2026-11-01 → 2026-11-14",
  "2026-11-15 → 2026-12-14",
  "2026-12-15 → 2027-01-14",
]);
check("weekly moved from Monday to Thursday", walk("WEEKLY", "2026-10-12..2026-10-18", 3, d(2026, 1, 1)).map(range), [
  "2026-10-12 → 2026-10-18",
  "2026-10-19 → 2026-10-21",
  "2026-10-22 → 2026-10-28",
]);
check("ordering still works on bridged names", isPeriodBefore("MONTHLY", "2026-11-01..2026-11-14", "2026-11-15..2026-12-14"), true);

section("the due date doesn't move the schedule");
{
  // Monthly, due 15 days after the month ends: October is due Nov 15, but
  // November still opens on Nov 1.
  const oct = parsePeriodName("2026-10");
  check("October is due Nov 15", ymd(engagementDueDate(oct.end, 15)), "2026-11-15");
  check("November still starts Nov 1", range(nextPeriodName("MONTHLY", "2026-10")!), "2026-11-01 → 2026-11-30");
  check("explained in the UI", describeRecurrenceVsDue(15, "MONTHLY"), "The next month still starts the day after this one ends, not on the due date, so the two overlap for 15 days.");
  check("one-time has nothing to explain", describeRecurrenceVsDue(15, "ONE_TIME"), null);
}

section("descriptions");
check("weekly default", describeSchedule("WEEKLY"), "A new period starts every Monday.");
check("monthly on the 15th", describeSchedule("MONTHLY", d(2026, 1, 15)), "A new period starts on the 15th of every month.");
check("fiscal year", describeSchedule("ANNUAL", d(2026, 7, 1)), "The year runs from Jul 1.");
check("semi-annual default", describeSchedule("SEMI_ANNUAL"), "New periods start on Jan 1, Jul 1.");

section("two periods of the same project at once");
{
  const rows = [
    { periodName: "2026-09", status: "DONE" as const },
    { periodName: "2026-10", status: "DONE" as const },
    { periodName: "2026-10", status: "IN_PROGRESS" as const },
    { periodName: "2026-11", status: "NOT_STARTED" as const },
  ];
  check("current + unfinished earlier periods are in play", [...periodsInPlay(rows, "2026-11")].sort(), ["2026-10", "2026-11"]);
  check("a finished period drops out", periodsInPlay(rows, "2026-11").has("2026-09"), false);
  check("the current period counts even with no rows yet", [...periodsInPlay([], "2026-12")], ["2026-12"]);
  // Finish-in-order is per period: November's step 1 can be done while
  // October's step 5 is still open.
  const novStep1 = { status: "NOT_STARTED" as const, taskSeqNo: 1 };
  check("periods don't block each other", canMarkDone(novStep1, [novStep1]), true);
}

finish();
