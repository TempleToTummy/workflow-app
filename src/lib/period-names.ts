import type { RecurringType } from "@prisma/client";

// Recurrence: what a cadence's periods are, what each is called, and which one
// comes next. No database access, so it's all testable on its own
// (scripts/test-core-rules.ts, scripts/test-recurrence.ts). src/lib/periods.ts
// re-exports it alongside the functions that do touch the database.
//
// --- Schedules -------------------------------------------------------------
//
// A schedule is a cadence plus an optional START DATE (the "anchor") that the
// periods are aligned to:
//
//   WEEKLY        7-day periods starting on the anchor's weekday.
//                 Default: Monday.
//   BIWEEKLY      14-day periods counted from the anchor (a pay-cycle date).
//                 Default: counted from Monday 1 Jan 2024.
//   SEMI_MONTHLY  The 1st–15th and the 16th–end of every month. Fixed halves,
//                 so the anchor only decides when the first period is.
//   MONTHLY       One month from the anchor's day of the month.
//                 Default: the 1st.
//   QUARTERLY     Three months from the anchor's month and day.
//                 Default: Jan/Apr/Jul/Oct 1.
//   SEMI_ANNUAL   Six months from the anchor's month and day.
//                 Default: Jan 1 and Jul 1.
//   ANNUAL        Twelve months from the anchor (a fiscal year).
//                 Default: Jan 1.
//   ONE_TIME      A single period, "ONE-TIME".
//
// Month-based anchors must fall on the 1st–28th so every month has the day.
//
// The DUE DATE plays no part in any of this. A period's due date is its end
// date plus the project's (or client's) due offset (src/lib/due-dates.ts); the
// next period always starts the day after this one ENDS, on the schedule. So a
// monthly project due 15 days after month end still opens November on Nov 1,
// while October's work is still due Nov 15.
//
// --- Names ---------------------------------------------------------------
//
// A period's name is derived from its date range alone, so a name can be
// turned back into dates without knowing the cadence:
//
//   2026-08                   a calendar month
//   2026-Q3                   a calendar quarter
//   2026-H1, 2026-H2          a calendar half-year
//   2026                      a calendar year
//   2026-10-12..2026-10-25    anything else (weeks, half-months, fiscal
//                             years, months that start on the 15th…)
//   ONE-TIME                  a one-time project
//
// Existing data only ever used the first, second and fourth forms, and those
// names are unchanged.
//
// --- Changing the start date mid-stream -----------------------------------
//
// The next period always starts the day after the current one ends, and runs
// to the end of the new schedule's period that contains that day. When nothing
// changed that is simply the next regular period. When the start date moved,
// it produces one shorter "bridging" period that lines the engagement up with
// the new schedule — so no days are skipped and none are worked twice.

export type Schedule = { type: RecurringType; anchor?: Date | null };
export type PeriodRange = { start: Date; end: Date };

export const RECURRING_TYPES: RecurringType[] = [
  "WEEKLY",
  "BIWEEKLY",
  "SEMI_MONTHLY",
  "MONTHLY",
  "QUARTERLY",
  "SEMI_ANNUAL",
  "ANNUAL",
  "ONE_TIME",
];

// The one place cadence names are spelled out, so every screen and export
// says the same thing.
export const RECURRING_LABELS: Record<RecurringType, string> = {
  WEEKLY: "Weekly",
  BIWEEKLY: "Every 2 weeks",
  SEMI_MONTHLY: "Twice a month (1st–15th, 16th–end)",
  MONTHLY: "Monthly",
  QUARTERLY: "Quarterly",
  SEMI_ANNUAL: "Every 6 months",
  ANNUAL: "Every year",
  ONE_TIME: "One time only",
};

export const RECURRING_SHORT_LABELS: Record<RecurringType, string> = {
  WEEKLY: "Weekly",
  BIWEEKLY: "Biweekly",
  SEMI_MONTHLY: "Semi-monthly",
  MONTHLY: "Monthly",
  QUARTERLY: "Quarterly",
  SEMI_ANNUAL: "Semi-annual",
  ANNUAL: "Annual",
  ONE_TIME: "One time",
};

export const RECURRING_HINTS: Record<RecurringType, string> = {
  WEEKLY: "Repeats every 7 days",
  BIWEEKLY: "Repeats every 14 days",
  SEMI_MONTHLY: "1st–15th, then 16th–end of month",
  MONTHLY: "Repeats every month",
  QUARTERLY: "Repeats every 3 months",
  SEMI_ANNUAL: "Repeats every 6 months",
  ANNUAL: "Repeats once a year",
  ONE_TIME: "Runs once and closes",
};

// Days for the fixed-length cadences, months for the calendar ones.
const DAY_CADENCE: Partial<Record<RecurringType, number>> = { WEEKLY: 7, BIWEEKLY: 14 };
const MONTH_CADENCE: Partial<Record<RecurringType, number>> = {
  MONTHLY: 1,
  QUARTERLY: 3,
  SEMI_ANNUAL: 6,
  ANNUAL: 12,
};

// Monday 1 Jan 2024: the default alignment for weekly and biweekly schedules.
const DEFAULT_DAY_ANCHOR = new Date(2024, 0, 1);
const DEFAULT_MONTH_ANCHOR = new Date(2024, 0, 1);

export const MAX_MONTH_ANCHOR_DAY = 28;

// The start date that applies to one client's engagement: its own override,
// else the project's, else none (the calendar default).
export function effectiveAnchor(
  projectAnchor: Date | null | undefined,
  engagementAnchor: Date | null | undefined
): Date | null {
  return engagementAnchor ?? projectAnchor ?? null;
}

export function usesAnchor(type: RecurringType): boolean {
  return type !== "ONE_TIME" && type !== "SEMI_MONTHLY";
}

// --- Date helpers (local midnight, like every period boundary in the app) ---

function day(y: number, m: number, d: number): Date {
  return new Date(y, m, d);
}

function startOfDay(date: Date): Date {
  return day(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date: Date, n: number): Date {
  return day(date.getFullYear(), date.getMonth(), date.getDate() + n);
}

// Whole days between two dates, immune to daylight-saving shifts.
function dayNumber(date: Date): number {
  return Math.round(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000);
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function isoDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function parseIsoDate(text: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) return null;
  const d = day(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return isoDate(d) === text ? d : null;
}

function lastDayOfMonth(y: number, m: number): number {
  return new Date(y, m + 1, 0).getDate();
}

// --- Anchors -------------------------------------------------------------------

export type AnchorCheck = { ok: true } | { ok: false; reason: string };

export function checkAnchor(type: RecurringType, anchor: Date | null | undefined): AnchorCheck {
  if (!anchor) return { ok: true };
  if (Number.isNaN(anchor.getTime())) return { ok: false, reason: "That isn't a valid date." };
  if (MONTH_CADENCE[type] && anchor.getDate() > MAX_MONTH_ANCHOR_DAY) {
    return {
      ok: false,
      reason: `Pick a start day from the 1st to the ${MAX_MONTH_ANCHOR_DAY}th, so every month has that day.`,
    };
  }
  return { ok: true };
}

// --- The core: which period contains a date ---------------------------------

export function periodContaining(schedule: Schedule, date: Date): PeriodRange {
  const d = startOfDay(date);
  const { type } = schedule;

  const days = DAY_CADENCE[type];
  if (days) {
    const anchor = startOfDay(schedule.anchor ?? DEFAULT_DAY_ANCHOR);
    const k = Math.floor((dayNumber(d) - dayNumber(anchor)) / days);
    const start = addDays(anchor, k * days);
    return { start, end: addDays(start, days - 1) };
  }

  const months = MONTH_CADENCE[type];
  if (months) {
    const anchor = schedule.anchor ?? DEFAULT_MONTH_ANCHOR;
    const aY = anchor.getFullYear();
    const aM = anchor.getMonth();
    const aD = Math.min(anchor.getDate(), MAX_MONTH_ANCHOR_DAY);
    let diff = (d.getFullYear() - aY) * 12 + (d.getMonth() - aM);
    if (d.getDate() < aD) diff -= 1;
    const k = Math.floor(diff / months);
    return {
      start: day(aY, aM + k * months, aD),
      end: day(aY, aM + (k + 1) * months, aD - 1),
    };
  }

  if (type === "SEMI_MONTHLY") {
    const y = d.getFullYear();
    const m = d.getMonth();
    return d.getDate() <= 15
      ? { start: day(y, m, 1), end: day(y, m, 15) }
      : { start: day(y, m, 16), end: day(y, m, lastDayOfMonth(y, m)) };
  }

  // ONE_TIME has no calendar; callers handle it by name.
  return { start: d, end: d };
}

// --- Names ---------------------------------------------------------------------

export const ONE_TIME_PERIOD = "ONE-TIME";

export function periodNameForRange({ start, end }: PeriodRange): string {
  const y = start.getFullYear();
  const m = start.getMonth();
  const startsMonth = start.getDate() === 1;
  const endsMonth = end.getDate() === lastDayOfMonth(end.getFullYear(), end.getMonth());
  const spanMonths = (end.getFullYear() - y) * 12 + (end.getMonth() - m) + 1;
  if (startsMonth && endsMonth) {
    if (spanMonths === 1) return `${y}-${pad(m + 1)}`;
    if (spanMonths === 3 && m % 3 === 0) return `${y}-Q${m / 3 + 1}`;
    if (spanMonths === 6 && m % 6 === 0) return `${y}-H${m / 6 + 1}`;
    if (spanMonths === 12 && m === 0) return `${y}`;
  }
  return `${isoDate(start)}..${isoDate(end)}`;
}

// The inverse of periodNameForRange. Throws on a name it can't place.
export function parsePeriodName(name: string): PeriodRange {
  let m: RegExpExecArray | null;
  if ((m = /^(\d{4})-(\d{1,2})$/.exec(name))) {
    const y = Number(m[1]);
    const mo = Number(m[2]) - 1;
    if (mo < 0 || mo > 11) throw new Error(`Unrecognised period "${name}".`);
    return { start: day(y, mo, 1), end: day(y, mo + 1, 0) };
  }
  if ((m = /^(\d{4})-Q([1-4])$/.exec(name))) {
    const y = Number(m[1]);
    const sm = (Number(m[2]) - 1) * 3;
    return { start: day(y, sm, 1), end: day(y, sm + 3, 0) };
  }
  if ((m = /^(\d{4})-H([12])$/.exec(name))) {
    const y = Number(m[1]);
    const sm = (Number(m[2]) - 1) * 6;
    return { start: day(y, sm, 1), end: day(y, sm + 6, 0) };
  }
  if ((m = /^(\d{4})$/.exec(name))) {
    const y = Number(m[1]);
    return { start: day(y, 0, 1), end: day(y, 11, 31) };
  }
  if ((m = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/.exec(name))) {
    const start = parseIsoDate(m[1]);
    const end = parseIsoDate(m[2]);
    if (start && end && start <= end) return { start, end };
  }
  throw new Error(`Unrecognised period "${name}".`);
}

export function isParseablePeriodName(name: string): boolean {
  try {
    parsePeriodName(name);
    return true;
  } catch {
    return false;
  }
}

// --- The scheduler's questions ------------------------------------------------

// The period a date falls in.
export function currentPeriodName(
  type: RecurringType,
  ref: Date = new Date(),
  anchor?: Date | null
): string {
  if (type === "ONE_TIME") return ONE_TIME_PERIOD;
  return periodNameForRange(periodContaining({ type, anchor }, ref));
}

// The first period of a brand-new engagement: the one today falls in, or — if
// the start date is in the future — the one that begins on the start date.
export function firstPeriodName(
  type: RecurringType,
  today: Date = new Date(),
  anchor?: Date | null
): string {
  if (type === "ONE_TIME") return ONE_TIME_PERIOD;
  const from = anchor && startOfDay(anchor) > startOfDay(today) ? anchor : today;
  return periodNameForRange(periodContaining({ type, anchor }, from));
}

// The period after `name`: starts the day after it ends, ends where the
// schedule's period containing that day ends. One-time projects don't recur.
export function nextPeriodName(type: RecurringType, name: string, anchor?: Date | null): string | null {
  if (type === "ONE_TIME") return null;
  const { end } = parsePeriodName(name);
  const start = addDays(end, 1);
  return periodNameForRange({ start, end: periodContaining({ type, anchor }, start).end });
}

// `type` is accepted for the older callers; names carry their own dates.
export function periodRangeForName(type: RecurringType, name: string): PeriodRange {
  if (type === "ONE_TIME" && name === ONE_TIME_PERIOD) {
    const now = startOfDay(new Date());
    return { start: now, end: now };
  }
  return parsePeriodName(name);
}

// Is period `a` strictly before period `b`? A malformed name never is, so a
// bad row can't spin the scheduler's catch-up loop.
export function isPeriodBefore(_type: RecurringType, a: string, b: string): boolean {
  if (a === b) return false;
  try {
    return parsePeriodName(a).start.getTime() < parsePeriodName(b).start.getTime();
  } catch {
    return false;
  }
}

// --- Display -----------------------------------------------------------------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// A period name as a person would say it. Calendar names are already
// readable and are left alone; ranges become "Oct 12 – 25, 2026".
export function formatPeriodName(name: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/.exec(name);
  if (!m) return name;
  const start = parseIsoDate(m[1]);
  const end = parseIsoDate(m[2]);
  if (!start || !end) return name;
  const sm = MONTHS[start.getMonth()];
  const em = MONTHS[end.getMonth()];
  if (start.getFullYear() !== end.getFullYear()) {
    return `${sm} ${start.getDate()}, ${start.getFullYear()} – ${em} ${end.getDate()}, ${end.getFullYear()}`;
  }
  if (start.getMonth() === end.getMonth()) {
    return `${sm} ${start.getDate()} – ${end.getDate()}, ${end.getFullYear()}`;
  }
  return `${sm} ${start.getDate()} – ${em} ${end.getDate()}, ${end.getFullYear()}`;
}

// One sentence describing when a schedule's periods start.
export function describeSchedule(type: RecurringType, anchor?: Date | null): string {
  const weekday = (d: Date) => d.toLocaleDateString("en-US", { weekday: "long" });
  const ordinal = (n: number) => {
    const s = n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th";
    return `${n}${s}`;
  };
  const monthDay = (d: Date) => `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  switch (type) {
    case "WEEKLY":
      return `A new period starts every ${weekday(anchor ?? DEFAULT_DAY_ANCHOR)}.`;
    case "BIWEEKLY":
      return anchor
        ? `A new period starts every other ${weekday(anchor)}, counting from ${monthDay(anchor)}, ${anchor.getFullYear()}.`
        : "A new period starts every other Monday. Set a start date to line it up with the client's pay cycle.";
    case "SEMI_MONTHLY":
      return "Periods run from the 1st to the 15th and from the 16th to the end of each month.";
    case "MONTHLY":
      return `A new period starts on the ${ordinal(anchor?.getDate() ?? 1)} of every month.`;
    case "QUARTERLY":
    case "SEMI_ANNUAL":
    case "ANNUAL": {
      const a = anchor ?? DEFAULT_MONTH_ANCHOR;
      const step = MONTH_CADENCE[type]!;
      const starts = Array.from({ length: 12 / step }, (_, i) =>
        monthDay(day(2024, a.getMonth() + i * step, Math.min(a.getDate(), MAX_MONTH_ANCHOR_DAY)))
      );
      return type === "ANNUAL"
        ? `The year runs from ${starts[0]}${anchor ? "" : " (calendar year)"}.`
        : `New periods start on ${starts.join(", ")}.`;
    }
    case "ONE_TIME":
      return "Runs once.";
  }
}
