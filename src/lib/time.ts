// Time tracking: the arithmetic and the parsing, with no next/* or Prisma
// import, so scripts/test-time-tracking.ts can exercise it directly.
//
// Everything here is deliberately pure. The rules that make a timesheet
// defensible are all edge cases — a timer left running over a weekend, "1:30"
// meaning ninety minutes and not one and a half thousand, a rate nobody has
// set — and they are much easier to get right (and to keep right) as functions
// over numbers than as branches inside a server action.

// A timer is capped when it's stopped, not while it runs. Somebody who starts
// a timer and goes home should not come back to a 400-hour entry, but the cap
// has to be visible rather than silent: stopTimer records the capped figure
// AND flags it, and the UI says the entry was capped so a human can correct
// it. Sixteen hours is past any real working day, so hitting it means the
// timer was forgotten, not that the work took that long.
export const MAX_TIMER_MINUTES = 16 * 60;

// Above this, a single entry is almost certainly a typo (a whole week booked
// to one task). Manual entry refuses it rather than accepting a number that
// would distort every rollup it lands in.
export const MAX_ENTRY_MINUTES = 24 * 60;

// --- Duration -----------------------------------------------------------------

// Whole minutes between two instants, floored and never negative. Floored
// rather than rounded on purpose: billing a minute that hasn't elapsed is the
// error with consequences.
export function minutesBetween(startedAt: Date, endedAt: Date): number {
  const ms = endedAt.getTime() - startedAt.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.floor(ms / 60_000);
}

export type StoppedTimer = { minutes: number; capped: boolean };

// What a stopped timer should record. Returns the capped value and says so,
// rather than throwing: the elapsed time is a fact that already happened, and
// refusing to stop the timer would leave it running forever.
export function stopTimer(startedAt: Date, endedAt: Date): StoppedTimer {
  const raw = minutesBetween(startedAt, endedAt);
  if (raw > MAX_TIMER_MINUTES) return { minutes: MAX_TIMER_MINUTES, capped: true };
  return { minutes: raw, capped: false };
}

// --- Parsing and formatting ---------------------------------------------------

// Accepts what people actually type into a duration box:
//   "90"      → 90 minutes
//   "1:30"    → 90 minutes
//   "1.5" "1.5h" → 90 minutes
//   "1h 30m" "1h30" "90m" → 90 minutes
//
// Returns null for anything it can't read, so the caller shows an error rather
// than silently logging a number the user didn't mean. A bare integer is read
// as MINUTES, not hours: the field is labelled minutes, and guessing hours
// would turn a 45-minute entry into a 45-hour one.
export function parseDuration(input: string): number | null {
  const raw = input.trim().toLowerCase();
  if (!raw) return null;

  // h:mm — the only form where the part after the separator is minutes rather
  // than a fraction, which is why it's matched before the decimal form.
  const clock = /^(\d+):([0-5]?\d)$/.exec(raw);
  if (clock) {
    return Number(clock[1]) * 60 + Number(clock[2]);
  }

  // "1h 30m", "1h30", "1h", "30m"
  const hm = /^(?:(\d+(?:\.\d+)?)\s*h)?\s*(?:(\d+)\s*m?)?$/.exec(raw);
  if (hm && (hm[1] !== undefined || hm[2] !== undefined)) {
    const hours = hm[1] !== undefined ? Number(hm[1]) : 0;
    const mins = hm[2] !== undefined ? Number(hm[2]) : 0;
    // A decimal with no unit ("1.5") means hours — nobody writes 1.5 minutes.
    if (hm[1] === undefined && raw.includes(".")) return null;
    const total = Math.round(hours * 60 + mins);
    return Number.isFinite(total) ? total : null;
  }

  // Bare decimal — hours, as above ("1.5" → 90).
  const dec = /^(\d+\.\d+)$/.exec(raw);
  if (dec) {
    const total = Math.round(Number(dec[1]) * 60);
    return Number.isFinite(total) ? total : null;
  }

  return null;
}

// "0m", "45m", "1h 30m", "7h". Used everywhere a duration is displayed, so
// hours and minutes never render inconsistently between two panels.
export function formatMinutes(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

// Decimal hours to two places — the shape a timesheet export and an invoice
// line want ("1.50" rather than "1h 30m").
export function toDecimalHours(minutes: number): number {
  return Math.round((Math.max(0, minutes) / 60) * 100) / 100;
}

// Live elapsed label for a running timer: "1:05:09". Seconds are shown because
// the whole point of a running clock is that it visibly moves.
export function formatElapsed(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

// --- Money --------------------------------------------------------------------

// Billable value of a block of time. Returns null when no rate applied, and
// that null is carried all the way to the UI as "—": a rate nobody entered is
// unknown, and rendering it as $0.00 would quietly report every unrated hour
// as worthless.
export function billableAmount(
  minutes: number,
  rate: number | null | undefined,
  billable: boolean
): number | null {
  if (rate === null || rate === undefined) return null;
  if (!billable) return 0;
  return Math.round(toDecimalHours(minutes) * rate * 100) / 100;
}

export function formatMoney(amount: number | null): string {
  if (amount === null) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(amount);
}

// --- Rollups ------------------------------------------------------------------

export type RollupEntry = {
  minutes: number;
  billable: boolean;
  rateSnapshot: number | null;
};

export type Rollup = {
  totalMinutes: number;
  billableMinutes: number;
  nonBillableMinutes: number;
  // Null when NOT ONE entry carried a rate. A partial rate picture still
  // produces a figure (from the entries that had one) — `ratedMinutes` says
  // how much of the total it actually covers, so a rollup can't imply it
  // priced work it couldn't price.
  amount: number | null;
  ratedMinutes: number;
  entryCount: number;
};

export function rollUp(entries: RollupEntry[]): Rollup {
  let totalMinutes = 0;
  let billableMinutes = 0;
  let amount = 0;
  let ratedMinutes = 0;
  let anyRate = false;

  for (const e of entries) {
    const mins = Math.max(0, e.minutes);
    totalMinutes += mins;
    if (e.billable) billableMinutes += mins;
    if (e.rateSnapshot !== null && e.rateSnapshot !== undefined) {
      anyRate = true;
      ratedMinutes += mins;
      amount += billableAmount(mins, e.rateSnapshot, e.billable) ?? 0;
    }
  }

  return {
    totalMinutes,
    billableMinutes,
    nonBillableMinutes: totalMinutes - billableMinutes,
    amount: anyRate ? Math.round(amount * 100) / 100 : null,
    ratedMinutes,
    entryCount: entries.length,
  };
}

// Billable hours over total hours, as a percentage — the firm's realization
// figure. Null for no time at all, because 0/0 is not 0%: it's a question with
// no answer, and printing "0% realization" against an empty week would read as
// a problem rather than an absence of data.
export function realizationPercent(rollup: {
  totalMinutes: number;
  billableMinutes: number;
}): number | null {
  if (rollup.totalMinutes <= 0) return null;
  return Math.round((rollup.billableMinutes / rollup.totalMinutes) * 1000) / 10;
}

// --- Date ranges --------------------------------------------------------------

export type DateRange = { start: Date; end: Date; label: string };

// Local-time day boundaries. Everything in this app's date handling is local
// (see src/lib/dates.ts) — going through UTC here would put a Monday-morning
// entry in the previous week for anyone west of Greenwich.
export function startOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

export function endOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(23, 59, 59, 999);
  return out;
}

// Monday-start weeks, matching dueBucket() in src/lib/dates.ts. Two different
// week definitions in one app would make the workload view and the due cards
// disagree about what "this week" means.
export function startOfWeek(d: Date): Date {
  const out = startOfDay(d);
  const dow = out.getDay(); // 0 = Sunday
  const back = dow === 0 ? 6 : dow - 1;
  out.setDate(out.getDate() - back);
  return out;
}

export const TIME_RANGES = ["this-week", "last-week", "this-month", "last-month", "all"] as const;
export type TimeRangeKey = (typeof TIME_RANGES)[number];

export function isTimeRange(value: string | null | undefined): value is TimeRangeKey {
  return !!value && (TIME_RANGES as readonly string[]).includes(value);
}

export const TIME_RANGE_LABELS: Record<TimeRangeKey, string> = {
  "this-week": "This week",
  "last-week": "Last week",
  "this-month": "This month",
  "last-month": "Last month",
  all: "All time",
};

// Resolves a range key to concrete bounds. "all" starts at the epoch rather
// than being a special case at every call site — one shape for every branch
// keeps the query builders free of null checks.
export function resolveRange(key: TimeRangeKey, now: Date = new Date()): DateRange {
  const label = TIME_RANGE_LABELS[key];
  switch (key) {
    case "this-week": {
      const start = startOfWeek(now);
      return { start, end: endOfDay(now), label };
    }
    case "last-week": {
      const thisWeek = startOfWeek(now);
      const start = new Date(thisWeek);
      start.setDate(start.getDate() - 7);
      const end = new Date(thisWeek);
      end.setMilliseconds(end.getMilliseconds() - 1);
      return { start, end, label };
    }
    case "this-month": {
      const start = startOfDay(new Date(now.getFullYear(), now.getMonth(), 1));
      return { start, end: endOfDay(now), label };
    }
    case "last-month": {
      const start = startOfDay(new Date(now.getFullYear(), now.getMonth() - 1, 1));
      const end = new Date(startOfDay(new Date(now.getFullYear(), now.getMonth(), 1)));
      end.setMilliseconds(end.getMilliseconds() - 1);
      return { start, end, label };
    }
    case "all":
      return { start: new Date(0), end: endOfDay(now), label };
  }
}
