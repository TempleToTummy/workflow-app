import { prisma } from "@/lib/prisma";
import {
  currentPeriodName,
  nextPeriodName,
  resolvePeriod,
  isPeriodBefore,
  periodRangeForName,
} from "@/lib/periods";
import { resolveStepDueDates } from "@/lib/due-dates";
import { resolveDefaultAssignees } from "@/lib/default-assignees";
import { recordAudit, AUDIT, SYSTEM_ACTOR } from "@/lib/audit";

// Scheduled work generation.
//
// The problem this fixes: period rollover used to happen ONLY inside
// updateActivityStatus — you ticked the last task of a period done, and that
// side effect opened the next one. So an engagement that fell behind stopped
// producing work entirely. Nobody was ever told; the dashboard just showed an
// engagement sitting in a period that had ended months ago, and "what's
// overdue" was unanswerable because the overdue work had never been created.
//
// generatePeriods() is the fix: for every active engagement it walks from the
// period it's parked in up to the period today falls in, opening each one
// along the way, regardless of whether the previous period was finished. An
// engagement that is three months behind ends up with three open periods on
// the board, which is the truth.
//
// It is idempotent — running it twice in a row creates nothing the second
// time — so it's safe to run from cron, from an admin button, or lazily on
// page load, all of which is wired up (see src/app/api/cron/generate-periods
// and ensurePeriodsCurrent below).

export const PERIOD_GENERATION_JOB = "period-generation";

// How far a single engagement may be walked forward in one run. A monthly
// engagement abandoned for five years is 60 periods; beyond that something is
// wrong with its data and we'd rather stop and report it than generate
// thousands of rows.
const MAX_CATCHUP_PERIODS = 60;

export type SchedulerTrigger = "cron" | "manual" | "auto";

export type RunSummary = {
  runId: string;
  status: "SUCCESS" | "FAILED";
  engagementsScanned: number;
  engagementsAdvanced: number;
  periodsCreated: number;
  activitiesCreated: number;
  assignmentsClosed: number;
  dueDatesWritten: number;
  skipped: { reason: string; count: number }[];
  notes: string[];
  startedAt: Date;
  finishedAt: Date;
  error?: string;
};

type Skip = "no-checklist" | "one-time" | "catchup-limit" | "bad-period-name";

const SKIP_LABELS: Record<Skip, string> = {
  "no-checklist": "project has no checklist steps yet",
  "one-time": "one-time project (does not recur)",
  "catchup-limit": "more than 60 periods behind — needs a manual look",
  "bad-period-name": "current period name could not be parsed",
};

// Opens one accounting period for one engagement: makes sure the period row
// exists, then creates any ClientActivity rows it is missing, each stamped
// with its resolved due date. Returns what it actually created, so a caller
// that runs this for 400 engagements can report real numbers.
//
// Exported because assignProjectToClient and the completion-triggered
// rollover both need to generate rows exactly the same way — three code paths
// writing ClientActivity rows by hand is how due dates end up inconsistent.
export async function openPeriodForAssignment(input: {
  clientId: string;
  projectId: string;
  periodName: string;
  // Supplied by callers that already loaded them, to avoid refetching per
  // engagement inside a batch run.
  project?: {
    recurringId: string;
    recurring: { type: import("@prisma/client").RecurringType };
    dueOffsetDays: number;
  };
  clientOverride?: number | null;
  // The engagement's default assignee, so a generated period arrives already
  // assigned instead of blank. Undefined means "look it up".
  engagementDefaultAssigneeId?: string | null;
  // Who to credit in the audit log. Defaults to the system (cron).
  actor?: { id: string | null; label: string };
}): Promise<{ periodCreated: boolean; activitiesCreated: number }> {
  const { clientId, projectId, periodName } = input;

  const project =
    input.project ??
    (await prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      include: { recurring: true },
    }));

  // One lookup covers both the due-date override and the default assignee when
  // the caller didn't already have them.
  const needsAssignment = input.engagementDefaultAssigneeId === undefined;
  const needsOverride = input.clientOverride === undefined;
  const assignment =
    needsAssignment || needsOverride
      ? await prisma.projectClientMap.findUnique({
          where: { clientId_projectId: { clientId, projectId } },
          select: { dueOffsetDays: true, defaultAssigneeId: true },
        })
      : null;

  const clientOverride = needsOverride
    ? assignment?.dueOffsetDays ?? null
    : input.clientOverride ?? null;
  const engagementDefaultAssigneeId = needsAssignment
    ? assignment?.defaultAssigneeId ?? null
    : input.engagementDefaultAssigneeId ?? null;

  const existingPeriod = await prisma.accountingPeriod.findUnique({
    where: { name: periodName },
  });
  const period =
    existingPeriod ??
    (await resolvePeriod(project.recurringId, project.recurring.type, periodName));

  const taskMaps = await prisma.projectTaskMap.findMany({
    where: { projectId },
    orderBy: { sequence: "asc" },
  });
  if (taskMaps.length === 0) {
    return { periodCreated: !existingPeriod, activitiesCreated: 0 };
  }

  // SQLite has no skipDuplicates on createMany, so dedupe explicitly against
  // what's already there. This is what makes the whole job safely re-runnable.
  const already = await prisma.clientActivity.findMany({
    where: { clientId, projectId, periodName },
    select: { subTaskId: true },
  });
  const have = new Set(already.map((a) => a.subTaskId));
  const missing = taskMaps.filter((tm) => !have.has(tm.subTaskId));
  if (missing.length === 0) {
    return { periodCreated: !existingPeriod, activitiesCreated: 0 };
  }

  const defaultAssignees = resolveDefaultAssignees({
    steps: taskMaps.map((tm) => ({
      subTaskId: tm.subTaskId,
      defaultAssigneeId: tm.defaultAssigneeId,
    })),
    engagementDefaultId: engagementDefaultAssigneeId,
  });

  const dueDates = resolveStepDueDates({
    periodEnd: period.endDate,
    projectOffset: project.dueOffsetDays,
    clientOverride,
    steps: taskMaps.map((tm) => ({
      subTaskId: tm.subTaskId,
      dueOffsetDays: tm.dueOffsetDays,
    })),
  });

  await prisma.clientActivity.createMany({
    data: missing.map((tm) => ({
      clientId,
      projectId,
      subTaskId: tm.subTaskId,
      periodName,
      taskSeqNo: tm.sequence,
      status: "NOT_STARTED" as const,
      dueDate: dueDates.get(tm.subTaskId) ?? period.endDate,
      assigneeId: defaultAssignees.get(tm.subTaskId) ?? null,
    })),
  });

  const assignedCount = missing.filter((tm) => defaultAssignees.has(tm.subTaskId)).length;
  await recordAudit({
    entityType: "ProjectClientMap",
    entityId: `${clientId}:${projectId}`,
    action: AUDIT.PERIOD_OPENED,
    summary:
      `Opened ${periodName} with ${missing.length} task${missing.length === 1 ? "" : "s"}` +
      (assignedCount > 0 ? `, ${assignedCount} pre-assigned from defaults` : ""),
    toValue: periodName,
    clientId,
    projectId,
    periodName,
    actor: input.actor ?? { id: null, label: SYSTEM_ACTOR },
  });

  return { periodCreated: !existingPeriod, activitiesCreated: missing.length };
}

// The job itself. Scans every active engagement and brings it up to the
// current period. Records a SchedulerRun row either way so there's a visible
// history of the job actually running (and of it failing).
export async function generatePeriods(options: {
  trigger: SchedulerTrigger;
  now?: Date;
}): Promise<RunSummary> {
  const now = options.now ?? new Date();
  const startedAt = new Date();

  const run = await prisma.schedulerRun.create({
    data: {
      job: PERIOD_GENERATION_JOB,
      trigger: options.trigger,
      status: "RUNNING",
      startedAt,
    },
  });

  const skips = new Map<Skip, number>();
  const notes: string[] = [];
  let engagementsScanned = 0;
  let engagementsAdvanced = 0;
  let periodsCreated = 0;
  let activitiesCreated = 0;
  let assignmentsClosed = 0;

  const noteSkip = (reason: Skip) => skips.set(reason, (skips.get(reason) ?? 0) + 1);

  try {
    const assignments = await prisma.projectClientMap.findMany({
      where: { active: true },
      include: {
        client: { select: { companyName: true } },
        project: {
          include: { recurring: true, _count: { select: { subtasks: true } } },
        },
      },
    });

    for (const assignment of assignments) {
      engagementsScanned += 1;
      const { clientId, projectId, project } = assignment;
      const type = project.recurring.type;

      // A one-time project has no next period — it finishes when its checklist
      // finishes (handled by the completion path), not on a calendar.
      if (type === "ONE_TIME") {
        // One-time work finishes when its checklist finishes, not on a
        // calendar. The completion path closes it, but an admin editing
        // statuses on /admin/client-activity bypasses that path entirely, so
        // sweep for finished-but-still-open one-timers here.
        if (await closeIfFinished(clientId, projectId)) assignmentsClosed += 1;
        else noteSkip("one-time");
        continue;
      }
      if (project._count.subtasks === 0) {
        noteSkip("no-checklist");
        continue;
      }

      const target = currentPeriodName(type, now);
      let cursor = assignment.currentPeriod ?? target;

      // A period name we can't place on a calendar would make the walk below
      // non-terminating; bail on this engagement rather than the whole run.
      if (!isParseablePeriod(type, cursor) || !isParseablePeriod(type, target)) {
        noteSkip("bad-period-name");
        continue;
      }

      // Every period from where this engagement is parked through the one we
      // are actually in, inclusive. Already-open periods are re-checked
      // cheaply (openPeriodForAssignment creates only what's missing), which
      // also repairs an engagement whose rows were partially generated.
      const toOpen: string[] = [cursor];
      let guard = 0;
      while (isPeriodBefore(type, cursor, target)) {
        if (guard++ >= MAX_CATCHUP_PERIODS) break;
        const next = nextPeriodName(type, cursor);
        if (!next) break;
        cursor = next;
        toOpen.push(cursor);
      }
      if (guard >= MAX_CATCHUP_PERIODS) {
        noteSkip("catchup-limit");
        notes.push(
          `${assignment.client.companyName} · ${project.name} is more than ${MAX_CATCHUP_PERIODS} periods behind and was left alone.`
        );
        continue;
      }

      let createdHere = 0;
      for (const periodName of toOpen) {
        const result = await openPeriodForAssignment({
          clientId,
          projectId,
          periodName,
          project: {
            recurringId: project.recurringId,
            recurring: { type },
            dueOffsetDays: project.dueOffsetDays,
          },
          clientOverride: assignment.dueOffsetDays,
          engagementDefaultAssigneeId: assignment.defaultAssigneeId,
        });
        if (result.periodCreated) periodsCreated += 1;
        createdHere += result.activitiesCreated;
      }
      activitiesCreated += createdHere;

      // currentPeriod points at the period the engagement is *working*, which
      // is now the one today falls in. Earlier periods stay on the board as
      // their own rows — that's the whole point, they're visibly late.
      const latest = toOpen[toOpen.length - 1];
      if (latest !== assignment.currentPeriod) {
        await prisma.projectClientMap.update({
          where: { clientId_projectId: { clientId, projectId } },
          data: { currentPeriod: latest },
        });
        engagementsAdvanced += 1;
        if (toOpen.length > 2) {
          notes.push(
            `${assignment.client.companyName} · ${project.name} was ${toOpen.length - 1} periods behind; opened ${toOpen[0]} → ${latest}.`
          );
        }
      }
    }

    const finishedAt = new Date();
    const detail = buildDetail({ skips, notes });
    await prisma.schedulerRun.update({
      where: { id: run.id },
      data: {
        status: "SUCCESS",
        finishedAt,
        engagementsScanned,
        periodsCreated,
        activitiesCreated,
        assignmentsClosed,
        dueDatesWritten: activitiesCreated,
        detail,
      },
    });

    return {
      runId: run.id,
      status: "SUCCESS",
      engagementsScanned,
      engagementsAdvanced,
      periodsCreated,
      activitiesCreated,
      assignmentsClosed,
      dueDatesWritten: activitiesCreated,
      skipped: [...skips].map(([reason, count]) => ({ reason: SKIP_LABELS[reason], count })),
      notes,
      startedAt,
      finishedAt,
    };
  } catch (err) {
    const finishedAt = new Date();
    const message = err instanceof Error ? err.message : String(err);
    await prisma.schedulerRun.update({
      where: { id: run.id },
      data: {
        status: "FAILED",
        finishedAt,
        engagementsScanned,
        periodsCreated,
        activitiesCreated,
        dueDatesWritten: activitiesCreated,
        detail: message,
      },
    });
    return {
      runId: run.id,
      status: "FAILED",
      engagementsScanned,
      engagementsAdvanced,
      periodsCreated,
      activitiesCreated,
      assignmentsClosed,
      dueDatesWritten: activitiesCreated,
      skipped: [],
      notes,
      startedAt,
      finishedAt,
      error: message,
    };
  }
}

// Pre-flights a period name through the same parser the walk below relies on,
// so an unparseable name is reported as a skip instead of comparing as NaN and
// spinning the catch-up loop.
function isParseablePeriod(
  type: import("@prisma/client").RecurringType,
  name: string
): boolean {
  try {
    const { start } = periodRangeForName(type, name);
    return !Number.isNaN(start.getTime());
  } catch {
    return false;
  }
}

// Marks a one-time engagement complete once every task it has is done.
// Returns whether it actually closed one.
async function closeIfFinished(clientId: string, projectId: string): Promise<boolean> {
  const rows = await prisma.clientActivity.findMany({
    where: { clientId, projectId },
    select: { status: true },
  });
  if (rows.length === 0 || !rows.every((r) => r.status === "DONE")) return false;
  await prisma.projectClientMap.update({
    where: { clientId_projectId: { clientId, projectId } },
    data: { completedDate: new Date(), active: false },
  });
  return true;
}

function buildDetail(input: {
  skips: Map<Skip, number>;
  notes: string[];
}): string | null {
  const parts: string[] = [];
  for (const [reason, count] of input.skips) {
    parts.push(`${count} skipped: ${SKIP_LABELS[reason]}`);
  }
  parts.push(...input.notes);
  return parts.length ? parts.join("\n") : null;
}

// --- Freshness -------------------------------------------------------------

// How stale the last successful run may be before the app considers the board
// untrustworthy. Cron should run daily; this is the "cron didn't fire" alarm.
export const STALE_AFTER_HOURS = 24;

export async function lastSuccessfulRun() {
  return prisma.schedulerRun.findFirst({
    where: { job: PERIOD_GENERATION_JOB, status: "SUCCESS" },
    orderBy: { startedAt: "desc" },
  });
}

// Lazy catch-up, so the feature works with no external scheduler attached.
// This app ships running on local SQLite with nothing to fire a cron at it, so
// the dashboard calls this on load: if no successful run has happened in the
// last few hours, generate now. In a deployment with real cron this almost
// never fires (cron beats it to the punch) and costs one indexed query.
//
// Set PERIOD_AUTOGEN=off to disable and rely on cron alone.
const AUTO_INTERVAL_HOURS = 6;
let inFlight: Promise<RunSummary | null> | null = null;

export async function ensurePeriodsCurrent(): Promise<RunSummary | null> {
  if (process.env.PERIOD_AUTOGEN === "off") return null;
  // Concurrent page loads must not each start a run; they share this one.
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const last = await lastSuccessfulRun();
      const cutoff = Date.now() - AUTO_INTERVAL_HOURS * 3600_000;
      if (last && last.startedAt.getTime() > cutoff) return null;
      return await generatePeriods({ trigger: "auto" });
    } catch {
      // Never let work generation take the dashboard down with it — the admin
      // Work Generation page surfaces failures.
      return null;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}
