import type { RecurringType } from "@prisma/client";
import { prisma } from "@/lib/prisma";

// Every recurring project needs a "current" accounting period to attach its
// first batch of ClientActivity rows to. The source app pre-populated these;
// here we derive the name from today's date and create the row on demand the
// first time a client is assigned to a project of that cadence.
export function currentPeriodName(type: RecurringType, ref: Date = new Date()): string {
  switch (type) {
    case "MONTHLY":
      return `${ref.getFullYear()}-${String(ref.getMonth() + 1).padStart(2, "0")}`;
    case "QUARTERLY": {
      const q = Math.floor(ref.getMonth() / 3) + 1;
      return `${ref.getFullYear()}-Q${q}`;
    }
    case "ANNUAL":
      return `${ref.getFullYear()}`;
    case "ONE_TIME":
      return "ONE-TIME";
  }
}

// Given a period's cadence and its name (e.g. "2026-08", "2026-Q3", "2026"),
// what's the name of the period immediately after it? One-time projects
// don't recur, so there is no next period.
export function nextPeriodName(type: RecurringType, name: string): string | null {
  switch (type) {
    case "MONTHLY": {
      // name's month is 1-indexed ("08"), so passing it straight into Date's
      // 0-indexed month param already lands on the following month, and
      // Date normalizes a December rollover into January of next year.
      const [y, m] = name.split("-").map(Number);
      const d = new Date(y, m, 1);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    }
    case "QUARTERLY": {
      const [yStr, qStr] = name.split("-Q");
      const y = Number(yStr);
      const q = Number(qStr);
      return q >= 4 ? `${y + 1}-Q1` : `${y}-Q${q + 1}`;
    }
    case "ANNUAL":
      return `${Number(name) + 1}`;
    case "ONE_TIME":
      return null;
  }
}

// Exported so the scheduler can order period names by when they actually
// start, rather than trusting that their names sort lexicographically.
export function periodRangeForName(type: RecurringType, name: string): { start: Date; end: Date } {
  switch (type) {
    case "MONTHLY": {
      const [y, m] = name.split("-").map(Number);
      return { start: new Date(y, m - 1, 1), end: new Date(y, m, 0) };
    }
    case "QUARTERLY": {
      const [yStr, qStr] = name.split("-Q");
      const y = Number(yStr);
      const startMonth = (Number(qStr) - 1) * 3;
      return { start: new Date(y, startMonth, 1), end: new Date(y, startMonth + 3, 0) };
    }
    case "ANNUAL": {
      const y = Number(name);
      return { start: new Date(y, 0, 1), end: new Date(y, 11, 31) };
    }
    case "ONE_TIME": {
      const now = new Date();
      return { start: now, end: now };
    }
  }
}

// Finds an AccountingPeriod by name for this cadence, creating it if this is
// the first time anything has needed it.
export async function resolvePeriod(recurringId: string, type: RecurringType, name: string) {
  const existing = await prisma.accountingPeriod.findUnique({ where: { name } });
  if (existing) return existing;

  const { start, end } = periodRangeForName(type, name);
  return prisma.accountingPeriod.create({
    data: { name, startDate: start, endDate: end, recurringId },
  });
}

export async function resolveCurrentPeriod(recurringId: string, type: RecurringType) {
  return resolvePeriod(recurringId, type, currentPeriodName(type));
}

// ProjectRecurring is a singleton per cadence (its `type` column is unique),
// so admin screens that just need "the MONTHLY one" can ask for it by type
// instead of looking up an id first.
export async function getRecurring(type: RecurringType) {
  return prisma.projectRecurring.upsert({
    where: { type },
    create: { type },
    update: {},
  });
}

// Is period `a` strictly before period `b` for this cadence? The scheduler
// walks an engagement forward until it reaches the period today falls in, and
// needs a real comparison to know when to stop — "2026-9" vs "2026-10" would
// sort wrong as text, and a malformed name must not spin the loop forever.
export function isPeriodBefore(type: RecurringType, a: string, b: string): boolean {
  if (a === b) return false;
  const sa = periodRangeForName(type, a).start.getTime();
  const sb = periodRangeForName(type, b).start.getTime();
  if (Number.isNaN(sa) || Number.isNaN(sb)) return false;
  return sa < sb;
}
