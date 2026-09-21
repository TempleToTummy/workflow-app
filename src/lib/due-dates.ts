import type { RecurringType } from "@prisma/client";

// Due dates, for real.
//
// Before this module every due date in the app was just the accounting
// period's end date, so every monthly client shared one deadline and every
// step inside an engagement shared it too. That's almost never the actual
// deadline: sales tax for August is due September 20th, a calendar-year
// business return is due March 15th, an individual return April 15th.
//
// A due date is now resolved from three layers, each one optional and
// falling back to the one above it:
//
//   1. Project.dueOffsetDays       — the service's rule: N days after the
//                                    period ends. 0 = last day of the period.
//   2. ProjectClientMap.dueOffsetDays — per-client override (an extension on
//                                    file, a negotiated turnaround).
//   3. ProjectTaskMap.dueOffsetDays   — per-step internal milestone, relative
//                                    to the engagement due date. Negative =
//                                    earlier (e.g. -7: review done a week out).
//
// The result is materialized onto ClientActivity.dueDate when rows are
// generated, so the dashboard sorts and filters in the database. Changing a
// rule recomputes the affected rows (see recomputeDueDates in actions.ts),
// except rows whose date a human set by hand (dueDateOverridden).

// Guard rails for anything typed into a form. A year of slack either way is
// more than any real filing deadline needs and keeps a typo ("2000") from
// pushing work off the board entirely.
export const MIN_OFFSET_DAYS = -365;
export const MAX_OFFSET_DAYS = 365;

export function clampOffset(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(MIN_OFFSET_DAYS, Math.min(MAX_OFFSET_DAYS, Math.trunc(value)));
}

// Parses an offset out of a form field. Empty/blank means "no override" for
// the nullable layers, which is different from 0 ("due the day the period
// ends") — hence null rather than a default.
export function parseOffset(raw: FormDataEntryValue | string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  if (!text) return null;
  const n = Number(text);
  if (!Number.isFinite(n)) return null;
  return clampOffset(n);
}

// Date-only arithmetic. Periods are stored as local midnight boundaries, so
// staying in local time keeps a due date on the day a human would name.
export function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + days);
  return d;
}

// The deadline for a whole engagement in one period: the period's end date
// pushed out by the effective offset.
export function engagementDueDate(periodEnd: Date, offsetDays: number): Date {
  return addDays(periodEnd, clampOffset(offsetDays));
}

// The deadline for one checklist step: the engagement's due date shifted by
// that step's own milestone offset, if it has one.
export function stepDueDate(engagementDue: Date, stepOffset: number | null | undefined): Date {
  if (stepOffset === null || stepOffset === undefined) return engagementDue;
  return addDays(engagementDue, clampOffset(stepOffset));
}

// Which offset actually applies to an engagement: the client's override when
// they have one, otherwise the service's rule.
export function effectiveOffset(
  projectOffset: number,
  clientOverride: number | null | undefined
): number {
  return clientOverride === null || clientOverride === undefined
    ? clampOffset(projectOffset)
    : clampOffset(clientOverride);
}

// Resolves every step's due date for one client/project/period in one pass.
// Shared by row generation (assign, rollover, the scheduler) and by the
// recompute path, so a rule change can never produce dates that differ from
// what generation would have written.
export function resolveStepDueDates(input: {
  periodEnd: Date;
  projectOffset: number;
  clientOverride: number | null | undefined;
  steps: { subTaskId: string; dueOffsetDays: number | null }[];
}): Map<string, Date> {
  const engagementDue = engagementDueDate(
    input.periodEnd,
    effectiveOffset(input.projectOffset, input.clientOverride)
  );
  return new Map(
    input.steps.map((s) => [s.subTaskId, stepDueDate(engagementDue, s.dueOffsetDays)])
  );
}

// --- Human-readable rules --------------------------------------------------

const CADENCE_NOUN: Record<RecurringType, string> = {
  MONTHLY: "month",
  QUARTERLY: "quarter",
  ANNUAL: "year",
  ONE_TIME: "period",
};

// One line explaining a project's deadline rule, for the forms and the
// project header. Kept in plain English on purpose — "dueOffsetDays: 20"
// means nothing to the person setting up a service.
export function describeDueRule(offsetDays: number, recurring: RecurringType): string {
  const noun = CADENCE_NOUN[recurring];
  const n = clampOffset(offsetDays);
  if (n === 0) return `Due on the last day of the ${noun}.`;
  if (n > 0) {
    return `Due ${n} day${n === 1 ? "" : "s"} after the ${noun} ends.`;
  }
  const early = Math.abs(n);
  return `Due ${early} day${early === 1 ? "" : "s"} before the ${noun} ends.`;
}

// Same, for a step's milestone offset relative to the engagement deadline.
export function describeStepOffset(offsetDays: number | null): string {
  if (offsetDays === null) return "Due with the project";
  const n = clampOffset(offsetDays);
  if (n === 0) return "Due with the project";
  if (n < 0) return `${Math.abs(n)}d before project due`;
  return `${n}d after project due`;
}

// A sensible starting rule when someone creates a new service, so a fresh
// project isn't silently "due on the last day of the period" for cadences
// where that's obviously wrong.
export const SUGGESTED_OFFSETS: Record<RecurringType, number> = {
  MONTHLY: 15,
  QUARTERLY: 30,
  ANNUAL: 75,
  ONE_TIME: 30,
};
