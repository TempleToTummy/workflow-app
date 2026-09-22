// Covers the time-tracking and workload arithmetic. No framework, no database:
//
//   ./node_modules/.bin/tsx scripts/test-time-tracking.ts
import { check, section, finish } from "./harness";
import {
  minutesBetween,
  stopTimer,
  parseDuration,
  formatMinutes,
  formatElapsed,
  toDecimalHours,
  billableAmount,
  formatMoney,
  rollUp,
  realizationPercent,
  startOfWeek,
  resolveRange,
  isTimeRange,
  MAX_TIMER_MINUTES,
  MAX_ENTRY_MINUTES,
} from "../src/lib/time";
import { summarizeWorkload, computeLoad, suggestAssignee } from "../src/lib/workload";

const at = (iso: string) => new Date(iso);

section("duration arithmetic");
check("a half-hour block", minutesBetween(at("2026-09-22T09:00:00"), at("2026-09-22T09:30:00")), 30);
check("partial minutes floor down", minutesBetween(at("2026-09-22T09:00:00"), at("2026-09-22T09:30:59")), 30);
check("a zero-length block is zero, not negative", minutesBetween(at("2026-09-22T09:00:00"), at("2026-09-22T09:00:00")), 0);
// A clock change or a bad manual edit can put the end before the start. That
// must not produce negative minutes that quietly reduce a rollup.
check("end before start clamps to zero", minutesBetween(at("2026-09-22T10:00:00"), at("2026-09-22T09:00:00")), 0);
check("an invalid date is zero, not NaN", minutesBetween(at("2026-09-22T09:00:00"), new Date("nonsense")), 0);

section("stopping a timer");
check("a normal stop records the elapsed time", stopTimer(at("2026-09-22T09:00:00"), at("2026-09-22T11:15:00")), { minutes: 135, capped: false });
// The forgotten-timer case: this is the one that would otherwise put a
// 400-hour entry into somebody's billing.
check("a timer left running overnight is capped", stopTimer(at("2026-09-21T09:00:00"), at("2026-09-22T17:00:00")), { minutes: MAX_TIMER_MINUTES, capped: true });
check("the cap is flagged, never silent", stopTimer(at("2026-09-21T09:00:00"), at("2026-09-22T17:00:00")).capped, true);
check("exactly at the cap is not flagged", stopTimer(at("2026-09-22T00:00:00"), at("2026-09-22T16:00:00")), { minutes: 960, capped: false });

section("parsing what people type");
check("bare number means minutes", parseDuration("90"), 90);
check("h:mm", parseDuration("1:30"), 90);
check("h:mm with a leading zero", parseDuration("0:45"), 45);
check("decimal means hours", parseDuration("1.5"), 90);
check("decimal hours with a unit", parseDuration("1.5h"), 90);
check("hours and minutes", parseDuration("1h 30m"), 90);
check("hours and minutes, no space", parseDuration("1h30"), 90);
check("hours only", parseDuration("2h"), 120);
check("minutes only", parseDuration("45m"), 45);
check("whitespace and case are ignored", parseDuration("  2H 15M "), 135);
check("zero is zero", parseDuration("0"), 0);
check("empty is unreadable", parseDuration(""), null);
check("prose is unreadable", parseDuration("about an hour"), null);
check("a stray unit is unreadable", parseDuration("90x"), null);
// 1:75 is not a time. Accepting it as 135 minutes would be guessing at what
// someone meant.
check("minutes over 59 in h:mm are rejected", parseDuration("1:75"), null);

section("formatting");
check("minutes under an hour", formatMinutes(45), "45m");
check("whole hours drop the minutes", formatMinutes(120), "2h");
check("hours and minutes", formatMinutes(135), "2h 15m");
check("zero reads as zero", formatMinutes(0), "0m");
check("negative minutes clamp", formatMinutes(-5), "0m");
check("elapsed under an hour", formatElapsed(65), "1:05");
check("elapsed over an hour pads", formatElapsed(3909), "1:05:09");
check("decimal hours for a timesheet", toDecimalHours(135), 2.25);
check("decimal hours round to two places", toDecimalHours(50), 0.83);

section("money");
check("two hours at 150", billableAmount(120, 150, true), 300);
check("non-billable time is worth zero", billableAmount(120, 150, false), 0);
// The important one: no rate is unknown, not free.
check("no rate yields null, not zero", billableAmount(120, null, true), null);
check("undefined rate yields null", billableAmount(120, undefined, true), null);
check("null renders as a dash", formatMoney(null), "—");
check("zero renders as money", formatMoney(0), "$0.00");

section("rollups");
const entries = [
  { minutes: 120, billable: true, rateSnapshot: 150 },
  { minutes: 60, billable: false, rateSnapshot: 150 },
  { minutes: 30, billable: true, rateSnapshot: 200 },
];
const rolled = rollUp(entries);
check("total minutes", rolled.totalMinutes, 210);
check("billable minutes exclude the write-off", rolled.billableMinutes, 150);
check("non-billable minutes are kept, not dropped", rolled.nonBillableMinutes, 60);
check("amount prices only the billable time", rolled.amount, 400);
check("rated minutes cover the whole total here", rolled.ratedMinutes, 210);
check("entry count", rolled.entryCount, 3);

const unrated = rollUp([{ minutes: 60, billable: true, rateSnapshot: null }]);
check("no rates anywhere → no amount", unrated.amount, null);
check("hours are still reported without a rate", unrated.totalMinutes, 60);

// A half-rated rollup must say how much of itself it could price, or the
// figure reads as the whole engagement's value.
const partial = rollUp([
  { minutes: 60, billable: true, rateSnapshot: 100 },
  { minutes: 60, billable: true, rateSnapshot: null },
]);
check("a partial rate picture still prices what it can", partial.amount, 100);
check("and says how many minutes that covered", partial.ratedMinutes, 60);
check("while reporting the full hours", partial.totalMinutes, 120);

check("an empty rollup is all zeroes with no amount", rollUp([]), {
  totalMinutes: 0,
  billableMinutes: 0,
  nonBillableMinutes: 0,
  amount: null,
  ratedMinutes: 0,
  entryCount: 0,
});

section("realization");
check("150 of 210 minutes billable", realizationPercent({ totalMinutes: 210, billableMinutes: 150 }), 71.4);
check("all billable is 100%", realizationPercent({ totalMinutes: 60, billableMinutes: 60 }), 100);
check("none billable is 0%", realizationPercent({ totalMinutes: 60, billableMinutes: 0 }), 0);
// 0/0 is a question with no answer. "0% realization" on an empty week would
// read as a problem rather than an absence of data.
check("no time logged has no realization figure", realizationPercent({ totalMinutes: 0, billableMinutes: 0 }), null);

section("date ranges");
// 2026-09-22 is a Tuesday.
check("week starts on Monday", startOfWeek(at("2026-09-22T15:00:00")).getDate(), 21);
// Sunday belongs to the week that started six days earlier, not the next one.
check("Sunday belongs to the week that just ended", startOfWeek(at("2026-09-27T15:00:00")).getDate(), 21);
check("Monday is its own week start", startOfWeek(at("2026-09-21T00:30:00")).getDate(), 21);
const lastWeek = resolveRange("last-week", at("2026-09-22T15:00:00"));
check("last week starts the previous Monday", lastWeek.start.getDate(), 14);
check("last week ends before this week begins", lastWeek.end < startOfWeek(at("2026-09-22T15:00:00")), true);
const thisMonth = resolveRange("this-month", at("2026-09-22T15:00:00"));
check("this month starts on the 1st", thisMonth.start.getDate(), 1);
const lastMonth = resolveRange("last-month", at("2026-09-22T15:00:00"));
check("last month starts on the 1st of August", [lastMonth.start.getMonth(), lastMonth.start.getDate()], [7, 1]);
check("last month ends before this month starts", lastMonth.end.getMonth(), 7);
check("a known range key is accepted", isTimeRange("this-week"), true);
check("an unknown range key is rejected", isTimeRange("since-forever"), false);
check("a missing range key is rejected", isTimeRange(null), false);

section("workload buckets");
const now = at("2026-09-22T12:00:00"); // Tuesday
const tasks = [
  { status: "NOT_STARTED", dueDate: at("2026-09-18T00:00:00"), estimatedMinutes: 60 },  // overdue
  { status: "IN_PROGRESS", dueDate: at("2026-09-22T00:00:00"), estimatedMinutes: 120 }, // today
  { status: "NOT_STARTED", dueDate: at("2026-09-25T00:00:00"), estimatedMinutes: 30 },  // this week
  { status: "NOT_STARTED", dueDate: at("2026-10-02T00:00:00"), estimatedMinutes: 90 },  // next week
  { status: "NOT_STARTED", dueDate: at("2026-12-01T00:00:00"), estimatedMinutes: null },// later, no estimate
  { status: "NOT_STARTED", dueDate: null, estimatedMinutes: null },                      // no due date
  { status: "DONE", dueDate: at("2026-09-10T00:00:00"), estimatedMinutes: 240 },         // excluded
];
const summary = summarizeWorkload(tasks, now);
check("done work is not carried", summary.openCount, 6);
check("committed minutes sum the estimates that exist", summary.committedMinutes, 300);
check("and a finished task's estimate is not among them", summary.committedMinutes < 540, true);
check("estimated task count", summary.estimatedCount, 4);
// The honesty case: two unestimated tasks are two unknowns, not zero hours.
check("unestimated open work is reported, not zeroed", summary.unestimatedCount, 2);
check("overdue is counted apart from the total", summary.overdueCount, 1);
check("overdue minutes", summary.overdueMinutes, 60);
check("buckets", summary.buckets, {
  overdue: 1,
  today: 1,
  thisWeek: 1,
  nextWeek: 1,
  later: 1,
  noDueDate: 1,
});

const empty = summarizeWorkload([], now);
check("an empty plate is zero open tasks", empty.openCount, 0);
check("with no committed hours", empty.committedMinutes, 0);

section("capacity");
check("half a 40-hour week", computeLoad({ committedMinutes: 1200, weeklyCapacityMinutes: 2400, estimatedCount: 5 }), { level: "steady", percent: 50 });
check("a light week", computeLoad({ committedMinutes: 240, weeklyCapacityMinutes: 2400, estimatedCount: 2 }), { level: "light", percent: 10 });
check("nearly full", computeLoad({ committedMinutes: 2160, weeklyCapacityMinutes: 2400, estimatedCount: 8 }), { level: "full", percent: 90 });
check("over capacity is reported, not clamped", computeLoad({ committedMinutes: 3600, weeklyCapacityMinutes: 2400, estimatedCount: 9 }), { level: "over", percent: 150 });
// Both of these withhold the percentage, for different reasons — a bar drawn
// from no data would be a fabrication either way.
check("no capacity on file → no percentage", computeLoad({ committedMinutes: 1200, weeklyCapacityMinutes: null, estimatedCount: 5 }), { level: "unknown", percent: null });
check("no estimates on file → no percentage", computeLoad({ committedMinutes: 0, weeklyCapacityMinutes: 2400, estimatedCount: 0 }), { level: "unknown", percent: null });
check("a zero capacity is treated as unset", computeLoad({ committedMinutes: 600, weeklyCapacityMinutes: 0, estimatedCount: 3 }), { level: "unknown", percent: null });

section("who gets the next task");
const people = [
  { name: "busy", load: computeLoad({ committedMinutes: 2200, weeklyCapacityMinutes: 2400, estimatedCount: 8 }), summary: summarizeWorkload([], now) },
  { name: "free", load: computeLoad({ committedMinutes: 300, weeklyCapacityMinutes: 2400, estimatedCount: 2 }), summary: summarizeWorkload([], now) },
  { name: "unknown", load: computeLoad({ committedMinutes: 0, weeklyCapacityMinutes: null, estimatedCount: 0 }), summary: summarizeWorkload([], now) },
];
check("the least loaded known person is suggested", suggestAssignee(people)?.name, "free");
// The subtle one: somebody whose load is unknown looks empty but isn't
// evidence of spare capacity, so they must not outrank a measured person.
check("unknown load never outranks a measured one", suggestAssignee([people[2], people[0]])?.name, "busy");
check("no people to suggest from", suggestAssignee([]), null);

section("entry caps");
check("the manual-entry ceiling is a full day", MAX_ENTRY_MINUTES, 1440);
check("and the timer cap sits below it", MAX_TIMER_MINUTES < MAX_ENTRY_MINUTES, true);

finish();
