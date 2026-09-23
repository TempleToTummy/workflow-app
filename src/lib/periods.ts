import type { RecurringType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { currentPeriodName, periodRangeForName } from "@/lib/period-names";

export {
  currentPeriodName,
  nextPeriodName,
  periodRangeForName,
  isPeriodBefore,
} from "@/lib/period-names";

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

