"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireUser, requireAdmin, type CurrentUser } from "@/lib/auth";
import { recordAudit, actorFrom, AUDIT } from "@/lib/audit";
import {
  stopTimer,
  formatMinutes,
  MAX_ENTRY_MINUTES,
  MAX_TIMER_MINUTES,
} from "@/lib/time";

// Time-tracking mutations.
//
// Like every other action module in this app, each function guards itself:
// server actions are reachable by direct POST, and src/proxy.ts only checks
// that a cookie exists.
//
// Two rules are enforced here rather than in the schema, because SQLite can't
// express either one:
//
//   1. At most one running timer per employee. Starting a second one stops the
//      first and says so, rather than refusing: a timer is a thing people
//      switch between all day, and an app that makes you find and stop the old
//      one first is an app whose timer nobody uses. The stopped entry keeps its
//      real elapsed time, so nothing is lost by switching.
//   2. You may only touch your own time, unless you're an admin. A timesheet
//      is evidence for billing; somebody else quietly editing yours would make
//      it worthless.

function revalidateTime(entry: { clientId: string | null; projectId: string | null }) {
  revalidatePath("/time");
  revalidatePath("/workload");
  revalidatePath("/reports/time-summary");
  revalidatePath("/activity");
  if (entry.clientId && entry.projectId) {
    revalidatePath(`/assignments/${entry.clientId}/${entry.projectId}`);
    revalidatePath(`/clients/${entry.clientId}`);
  }
}

// Who a write is allowed to target. An employee may only write their own time;
// an admin may log or correct anyone's (a partner fixing a timesheet before
// invoicing is a real workflow). Returns the employee id to write against.
async function resolveSubject(user: CurrentUser, requestedEmployeeId?: string | null): Promise<string> {
  const wanted = requestedEmployeeId?.trim() || user.id;
  if (wanted === user.id) return wanted;
  if (user.role !== "ADMIN") {
    throw new Error("You can only log time against your own timesheet.");
  }
  await prisma.employee.findUniqueOrThrow({ where: { id: wanted }, select: { id: true } });
  return wanted;
}

// The engagement context for an entry, read from the activity rather than
// taken from the caller. A client-supplied clientId would let anyone book time
// against any client by editing the request.
async function contextForActivity(activityId: string) {
  const activity = await prisma.clientActivity.findUniqueOrThrow({
    where: { id: activityId },
    include: {
      subTask: { select: { name: true } },
      client: { select: { companyName: true } },
      project: { select: { name: true } },
    },
  });
  return {
    activityId: activity.id,
    clientId: activity.clientId,
    projectId: activity.projectId,
    periodName: activity.periodName,
    label: `${activity.client.companyName} · ${activity.project.name} · ${activity.subTask.name}`,
    contextLabel: `${activity.client.companyName} · ${activity.project.name}`,
  };
}

// The rate to stamp on a new entry. Read at write time and frozen on the row:
// raising somebody's rate must not restate last quarter's billing.
async function rateFor(employeeId: string): Promise<number | null> {
  const employee = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: { hourlyRate: true },
  });
  return employee?.hourlyRate ?? null;
}

// --- The timer ----------------------------------------------------------------

export type StartTimerResult = {
  entryId: string;
  // Set when starting this timer stopped another one, so the UI can say
  // "Stopped your timer on Bank Reconciliation (25m)" instead of silently
  // moving the clock.
  stopped: { label: string; minutes: number; capped: boolean } | null;
};

export async function startTimer(activityId: string): Promise<StartTimerResult> {
  const user = await requireUser();
  const context = await contextForActivity(activityId);

  // Stop whatever else is running first. Doing this before the insert means a
  // failure here leaves one running timer, not two.
  const stopped = await stopRunningTimerFor(user, { silent: true });

  const entry = await prisma.timeEntry.create({
    data: {
      employeeId: user.id,
      activityId: context.activityId,
      clientId: context.clientId,
      projectId: context.projectId,
      periodName: context.periodName,
      startedAt: new Date(),
      endedAt: null,
      minutes: 0,
      source: "timer",
      rateSnapshot: await rateFor(user.id),
    },
  });

  revalidateTime(context);
  return { entryId: entry.id, stopped };
}

// Stops the caller's running timer. Returns null when nothing was running,
// which is not an error — two tabs both pressing stop is a normal race, and
// throwing would show the second one a crash for having agreed with the first.
export async function stopRunningTimer(): Promise<{
  label: string;
  minutes: number;
  capped: boolean;
} | null> {
  const user = await requireUser();
  return stopRunningTimerFor(user, { silent: false });
}

async function stopRunningTimerFor(
  user: CurrentUser,
  options: { silent: boolean }
): Promise<{ label: string; minutes: number; capped: boolean } | null> {
  const running = await prisma.timeEntry.findFirst({
    where: { employeeId: user.id, endedAt: null },
    orderBy: { startedAt: "desc" },
    include: {
      client: { select: { companyName: true } },
      project: { select: { name: true } },
      activity: { include: { subTask: { select: { name: true } } } },
    },
  });
  if (!running) return null;

  const endedAt = new Date();
  const { minutes, capped } = stopTimer(running.startedAt, endedAt);

  await prisma.timeEntry.update({
    where: { id: running.id },
    data: {
      endedAt,
      minutes,
      // A capped entry is flagged in its own note rather than silently
      // shortened, so whoever reviews the timesheet can see that the figure is
      // a ceiling and not a measurement.
      note:
        capped && !running.note
          ? `Timer ran past ${formatMinutes(MAX_TIMER_MINUTES)} and was capped — please correct if the real time differs.`
          : running.note,
    },
  });

  const label = running.activity
    ? `${running.activity.subTask.name}`
    : (running.project?.name ?? "time");

  await recordAudit({
    entityType: "TimeEntry",
    entityId: running.id,
    action: AUDIT.TIME_LOGGED,
    summary: `Logged ${formatMinutes(minutes)} on ${label}${capped ? " (capped — timer left running)" : ""}`,
    toValue: String(minutes),
    clientId: running.clientId,
    projectId: running.projectId,
    periodName: running.periodName,
    contextLabel: running.client?.companyName ?? null,
    actor: actorFrom(user),
  });

  if (!options.silent) {
    revalidateTime(running);
  }
  return { label, minutes, capped };
}

// A timer started on the wrong task. Deletes it outright rather than logging a
// zero-minute entry — a mis-click is not work, and a timesheet full of 0m rows
// is a timesheet nobody reads. Only ever reachable for a RUNNING entry, so it
// cannot be used to erase time that was already recorded.
export async function discardRunningTimer(): Promise<boolean> {
  const user = await requireUser();
  const running = await prisma.timeEntry.findFirst({
    where: { employeeId: user.id, endedAt: null },
    orderBy: { startedAt: "desc" },
  });
  if (!running) return false;
  await prisma.timeEntry.delete({ where: { id: running.id } });
  revalidateTime(running);
  return true;
}

// --- Manual entry -------------------------------------------------------------

export type ManualTimeInput = {
  // One of these two. An activity gives the full engagement context; a client
  // alone covers "two hours on the phone about next year" with no task open.
  activityId?: string | null;
  clientId?: string | null;
  projectId?: string | null;
  periodName?: string | null;
  minutes: number;
  // yyyy-mm-dd. The work day being recorded, not the moment of typing.
  date?: string | null;
  billable?: boolean;
  note?: string | null;
  // Admin only — logging on behalf of somebody else.
  employeeId?: string | null;
};

export async function logManualTime(input: ManualTimeInput): Promise<{ id: string }> {
  const user = await requireUser();
  const employeeId = await resolveSubject(user, input.employeeId);

  const minutes = Math.round(input.minutes);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new Error("Enter how long the work took.");
  }
  if (minutes > MAX_ENTRY_MINUTES) {
    throw new Error(
      `A single entry can't be longer than ${formatMinutes(MAX_ENTRY_MINUTES)}. Split it across days.`
    );
  }

  let context: {
    activityId: string | null;
    clientId: string | null;
    projectId: string | null;
    periodName: string | null;
    label: string;
    contextLabel: string | null;
  };

  if (input.activityId) {
    const resolved = await contextForActivity(input.activityId);
    context = { ...resolved };
  } else if (input.clientId) {
    const client = await prisma.client.findUniqueOrThrow({
      where: { id: input.clientId },
      select: { id: true, companyName: true },
    });
    const project = input.projectId
      ? await prisma.project.findUniqueOrThrow({
          where: { id: input.projectId },
          select: { id: true, name: true },
        })
      : null;
    context = {
      activityId: null,
      clientId: client.id,
      projectId: project?.id ?? null,
      periodName: input.periodName?.trim() || null,
      label: project ? `${client.companyName} · ${project.name}` : client.companyName,
      contextLabel: client.companyName,
    };
  } else {
    // Internal time. Allowed, and deliberately not forced onto a client:
    // booking admin time to whichever client happened to be handy is how a
    // profitability report becomes fiction.
    context = {
      activityId: null,
      clientId: null,
      projectId: null,
      periodName: null,
      label: "internal time",
      contextLabel: null,
    };
  }

  // The entry's start is anchored to the date given (at 09:00 local, so it
  // lands inside the working day it describes rather than on a boundary where
  // a week or month rollup could claim it either way), with the end derived
  // from the duration. A manual entry's timestamps are a human's recollection,
  // which is what `source` records.
  const startedAt = resolveManualStart(input.date);
  const endedAt = new Date(startedAt.getTime() + minutes * 60_000);

  const entry = await prisma.timeEntry.create({
    data: {
      employeeId,
      activityId: context.activityId,
      clientId: context.clientId,
      projectId: context.projectId,
      periodName: context.periodName,
      startedAt,
      endedAt,
      minutes,
      billable: input.billable ?? true,
      note: input.note?.trim() || null,
      source: "manual",
      rateSnapshot: await rateFor(employeeId),
    },
  });

  await recordAudit({
    entityType: "TimeEntry",
    entityId: entry.id,
    action: AUDIT.TIME_LOGGED,
    summary: `Logged ${formatMinutes(minutes)} on ${context.label}${
      input.billable === false ? " (non-billable)" : ""
    }${employeeId === user.id ? "" : " on behalf of a colleague"}`,
    toValue: String(minutes),
    clientId: context.clientId,
    projectId: context.projectId,
    periodName: context.periodName,
    contextLabel: context.contextLabel,
    actor: actorFrom(user),
  });

  revalidateTime(context);
  return { id: entry.id };
}

// yyyy-mm-dd → 09:00 local on that day. A bare `new Date("2026-09-22")` parses
// as UTC midnight, which is the previous day for anyone west of Greenwich and
// would file Monday's work under Sunday.
function resolveManualStart(date: string | null | undefined): Date {
  if (!date) {
    return new Date();
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  if (!match) throw new Error("That date doesn't look right.");
  const [, y, m, d] = match;
  const parsed = new Date(Number(y), Number(m) - 1, Number(d), 9, 0, 0, 0);
  if (Number.isNaN(parsed.getTime())) throw new Error("That date doesn't look right.");
  // A timesheet is a record of work done, so a date in the future is a typo.
  // Tomorrow is allowed as slack for time zones and late-night entries.
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (parsed > tomorrow) throw new Error("You can't log time against a future date.");
  return parsed;
}

// --- Correcting an entry ------------------------------------------------------

async function loadOwnEntry(user: CurrentUser, id: string) {
  const entry = await prisma.timeEntry.findUniqueOrThrow({
    where: { id },
    include: {
      client: { select: { companyName: true } },
      activity: { include: { subTask: { select: { name: true } } } },
    },
  });
  if (entry.employeeId !== user.id && user.role !== "ADMIN") {
    throw new Error("That entry belongs to someone else's timesheet.");
  }
  return entry;
}

export async function updateTimeEntry(
  id: string,
  data: { minutes?: number; billable?: boolean; note?: string | null }
): Promise<void> {
  const user = await requireUser();
  const before = await loadOwnEntry(user, id);
  if (before.endedAt === null) {
    throw new Error("Stop the timer before editing this entry.");
  }

  const minutes = data.minutes === undefined ? before.minutes : Math.round(data.minutes);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new Error("Enter how long the work took.");
  }
  if (minutes > MAX_ENTRY_MINUTES) {
    throw new Error(
      `A single entry can't be longer than ${formatMinutes(MAX_ENTRY_MINUTES)}. Split it across days.`
    );
  }

  const billable = data.billable ?? before.billable;
  const note = data.note === undefined ? before.note : data.note?.trim() || null;
  if (minutes === before.minutes && billable === before.billable && note === before.note) {
    return;
  }

  await prisma.timeEntry.update({
    where: { id },
    data: {
      minutes,
      billable,
      note,
      // Keep endedAt consistent with the corrected duration, so the row never
      // says one thing in its timestamps and another in its total.
      endedAt: new Date(before.startedAt.getTime() + minutes * 60_000),
    },
  });

  await recordAudit({
    entityType: "TimeEntry",
    entityId: id,
    action: AUDIT.TIME_EDITED,
    summary: `Corrected time on ${before.activity?.subTask.name ?? "an entry"}: ${formatMinutes(
      before.minutes
    )} → ${formatMinutes(minutes)}${billable === before.billable ? "" : billable ? ", now billable" : ", now non-billable"}`,
    fromValue: String(before.minutes),
    toValue: String(minutes),
    clientId: before.clientId,
    projectId: before.projectId,
    periodName: before.periodName,
    contextLabel: before.client?.companyName ?? null,
    actor: actorFrom(user),
  });

  revalidateTime(before);
}

export async function deleteTimeEntry(id: string): Promise<void> {
  const user = await requireUser();
  const before = await loadOwnEntry(user, id);
  await prisma.timeEntry.delete({ where: { id } });

  // Recorded AFTER the delete and with no foreign key, so the record of the
  // deletion survives the row. Deleting billable time is exactly the action
  // somebody would later want to question.
  await recordAudit({
    entityType: "TimeEntry",
    entityId: id,
    action: AUDIT.TIME_DELETED,
    summary: `Deleted ${formatMinutes(before.minutes)} logged on ${
      before.activity?.subTask.name ?? before.client?.companyName ?? "internal time"
    }`,
    fromValue: String(before.minutes),
    clientId: before.clientId,
    projectId: before.projectId,
    periodName: before.periodName,
    contextLabel: before.client?.companyName ?? null,
    actor: actorFrom(user),
  });

  revalidateTime(before);
}

// --- Rates and capacity (admin) ----------------------------------------------

// Both are admin-only: a rate is commercially sensitive, and capacity is a
// management figure that somebody could otherwise raise to look less loaded.
export async function setEmployeeBilling(
  employeeId: string,
  data: { hourlyRate?: number | null; weeklyCapacityMinutes?: number | null }
): Promise<void> {
  const admin = await requireAdmin();
  const before = await prisma.employee.findUniqueOrThrow({
    where: { id: employeeId },
    select: { firstName: true, lastName: true, hourlyRate: true, weeklyCapacityMinutes: true },
  });

  const rate =
    data.hourlyRate === undefined
      ? before.hourlyRate
      : data.hourlyRate === null || Number.isNaN(data.hourlyRate)
        ? null
        : Math.max(0, Math.round(data.hourlyRate * 100) / 100);
  const capacity =
    data.weeklyCapacityMinutes === undefined
      ? before.weeklyCapacityMinutes
      : data.weeklyCapacityMinutes === null || Number.isNaN(data.weeklyCapacityMinutes)
        ? null
        : Math.max(0, Math.round(data.weeklyCapacityMinutes));

  if (rate !== null && rate > 100_000) {
    throw new Error("That hourly rate looks like a typo.");
  }
  // A 168-hour week is every hour there is. Anything at or above it is a
  // units mistake (hours typed into a minutes field).
  if (capacity !== null && capacity > 168 * 60) {
    throw new Error("A weekly capacity can't exceed the hours in a week.");
  }

  await prisma.employee.update({
    where: { id: employeeId },
    data: { hourlyRate: rate, weeklyCapacityMinutes: capacity },
  });

  const who = `${before.firstName} ${before.lastName}`;
  if (rate !== before.hourlyRate) {
    await recordAudit({
      entityType: "Employee",
      entityId: employeeId,
      action: AUDIT.RATE_CHANGED,
      // Existing time entries keep the rate they were logged at, which is the
      // whole reason rateSnapshot exists — worth saying in the log, because
      // "did this change restate last month?" is the first question asked.
      summary: `${who}'s billing rate: ${before.hourlyRate ?? "unset"} → ${
        rate ?? "unset"
      } (already-logged time keeps its original rate)`,
      fromValue: before.hourlyRate === null ? null : String(before.hourlyRate),
      toValue: rate === null ? null : String(rate),
      contextLabel: who,
      actor: actorFrom(admin),
    });
  }
  if (capacity !== before.weeklyCapacityMinutes) {
    await recordAudit({
      entityType: "Employee",
      entityId: employeeId,
      action: AUDIT.CAPACITY_CHANGED,
      summary: `${who}'s weekly capacity: ${
        before.weeklyCapacityMinutes ? formatMinutes(before.weeklyCapacityMinutes) : "unset"
      } → ${capacity ? formatMinutes(capacity) : "unset"}`,
      fromValue: before.weeklyCapacityMinutes === null ? null : String(before.weeklyCapacityMinutes),
      toValue: capacity === null ? null : String(capacity),
      contextLabel: who,
      actor: actorFrom(admin),
    });
  }

  revalidatePath("/admin/employees");
  revalidatePath("/workload");
  revalidatePath("/reports/time-summary");
}
