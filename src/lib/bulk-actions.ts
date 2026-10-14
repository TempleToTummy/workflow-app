"use server";

import { revalidatePath } from "next/cache";
import type { ActivityStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireUser, type CurrentUser } from "@/lib/auth";
import { canAccessEngagement, assertEmployeeExists } from "@/lib/access";
import { recordAuditMany, actorFrom, AUDIT, STATUS_WORDS } from "@/lib/audit";
import { planBulkStatus, MAX_BULK, type PlannableTask } from "@/lib/bulk";
import { maybeRollPeriodForward } from "@/lib/rollover";

// Bulk actions for the Tasks list and the dashboard.
//
// Every bulk action checks access per engagement — the same rule as the
// single-row actions (src/lib/permissions.ts) — and skips rows the caller
// can't touch instead of failing the whole batch, reporting how many and why.
// Every changed row gets its own audit entry, like bulk reassignment on the
// assignment page already does.

const STATUSES: ActivityStatus[] = ["NOT_STARTED", "IN_PROGRESS", "AWAITING_REVIEW", "DONE"];

export type BulkResult = {
  changed: number;
  unchanged: number;
  skipped: { label: string; reason: string }[];
};

function name(e: { firstName: string; lastName: string } | null): string {
  return e ? `${e.firstName} ${e.lastName}` : "Unassigned";
}

// Engagement-level access, memoized for one request: twenty selected steps on
// one engagement are one access query, not twenty.
function accessChecker(user: CurrentUser) {
  const cache = new Map<string, Promise<boolean>>();
  return (clientId: string, projectId: string, instance: number) => {
    const key = `${clientId}:${projectId}:${instance}`;
    let hit = cache.get(key);
    if (!hit) {
      hit = canAccessEngagement(user, clientId, projectId, instance);
      cache.set(key, hit);
    }
    return hit;
  };
}

const NO_ACCESS = "Not an engagement you're assigned to.";

// One period of one engagement. NUL-separated: period names never contain it.
function groupKey(a: { clientId: string; projectId: string; instance: number; periodName: string }): string {
  return [a.clientId, a.projectId, String(a.instance), a.periodName].join("\u0000");
}

function parseGroupKey(key: string) {
  const [clientId, projectId, instance, periodName] = key.split("\u0000");
  return { clientId, projectId, instance: Number(instance), periodName };
}

function revalidateBulk(engagements: Iterable<string>) {
  revalidatePath("/");
  revalidatePath("/tasks");
  revalidatePath("/workload");
  revalidatePath("/activity");
  for (const key of engagements) {
    const [clientId, projectId] = key.split("\u0000");
    revalidatePath(`/assignments/${clientId}/${projectId}`);
  }
}

// --- Status -----------------------------------------------------------------------

export async function bulkUpdateTaskStatus(
  activityIds: string[],
  newStatus: ActivityStatus
): Promise<BulkResult> {
  const user = await requireUser();
  if (!STATUSES.includes(newStatus)) throw new Error("Pick a status.");
  const ids = [...new Set(activityIds)];
  if (ids.length === 0) return { changed: 0, unchanged: 0, skipped: [] };
  if (ids.length > MAX_BULK) throw new Error(`Select at most ${MAX_BULK} tasks at a time.`);

  const selected = await prisma.clientActivity.findMany({
    where: { id: { in: ids } },
    select: { id: true, clientId: true, projectId: true, instance: true, periodName: true },
  });
  const canAccess = accessChecker(user);
  const allowedIds: string[] = [];
  const skipped: BulkResult["skipped"] = [];
  const groupKeys = new Set<string>();
  for (const a of selected) {
    if (await canAccess(a.clientId, a.projectId, a.instance)) {
      allowedIds.push(a.id);
      groupKeys.add(groupKey(a));
    } else {
      skipped.push({ label: "A task", reason: NO_ACCESS });
    }
  }

  // Every sibling in every affected period, for the sequential rule.
  const siblings = await prisma.clientActivity.findMany({
    where: {
      OR: [...groupKeys].map(parseGroupKey),
    },
    include: {
      subTask: { select: { name: true } },
      client: { select: { companyName: true } },
      project: { select: { name: true } },
    },
  });
  const byId = new Map(siblings.map((s) => [s.id, s]));
  const tasks: PlannableTask[] = siblings.map((s) => ({
    id: s.id,
    groupKey: groupKey(s),
    taskSeqNo: s.taskSeqNo,
    status: s.status,
    label: s.subTask.name,
  }));

  const plan = planBulkStatus(allowedIds, groupKeys.size ? tasks : [], newStatus);
  for (const s of plan.skipped) {
    const row = byId.get(s.id);
    skipped.push({
      label: row ? `${row.client.companyName} · ${row.subTask.name}` : "A task",
      reason: s.reason,
    });
  }
  // Ids selected but no longer in the database at all.
  for (const id of ids) {
    if (!selected.some((a) => a.id === id)) skipped.push({ label: "A task", reason: "That task no longer exists." });
  }

  if (plan.apply.length > 0) {
    const now = new Date();
    await prisma.clientActivity.updateMany({
      where: { id: { in: plan.apply } },
      data: {
        status: newStatus,
        // Same completion stamp as the single-step action: set on Done,
        // cleared on anything else so a withdrawn sign-off doesn't linger.
        completedAt: newStatus === "DONE" ? now : null,
        completedById: newStatus === "DONE" ? user.id : null,
      },
    });
    await recordAuditMany(
      plan.apply.map((id) => {
        const a = byId.get(id)!;
        return {
          entityType: "ClientActivity",
          entityId: id,
          action: AUDIT.STATUS_CHANGED,
          summary: `${a.subTask.name}: ${STATUS_WORDS[a.status] ?? a.status} → ${
            STATUS_WORDS[newStatus] ?? newStatus
          } (bulk)`,
          fromValue: a.status,
          toValue: newStatus,
          clientId: a.clientId,
          projectId: a.projectId,
          instance: a.instance,
          periodName: a.periodName,
          contextLabel: `${a.client.companyName} · ${a.project.name}`,
          actor: actorFrom(user),
        };
      })
    );

    // Finishing a period by bulk rolls it forward exactly like finishing it
    // one step at a time.
    if (newStatus === "DONE") {
      const finished = new Set(plan.apply.map((id) => groupKey(byId.get(id)!)));
      for (const key of finished) {
        const { clientId, projectId, instance, periodName } = parseGroupKey(key);
        await maybeRollPeriodForward(clientId, projectId, periodName, instance);
      }
    }
  }

  revalidateBulk([...groupKeys]);
  return { changed: plan.apply.length, unchanged: plan.unchanged.length, skipped };
}

// --- Assignee (Tasks list: individual steps) ---------------------------------------

export async function bulkAssignTasks(activityIds: string[], employeeId: string): Promise<BulkResult> {
  const user = await requireUser();
  const assigneeId = employeeId || null;
  await assertEmployeeExists(assigneeId);
  const ids = [...new Set(activityIds)];
  if (ids.length === 0) return { changed: 0, unchanged: 0, skipped: [] };
  if (ids.length > MAX_BULK) throw new Error(`Select at most ${MAX_BULK} tasks at a time.`);

  const rows = await prisma.clientActivity.findMany({
    where: { id: { in: ids } },
    include: {
      subTask: { select: { name: true } },
      client: { select: { companyName: true } },
      project: { select: { name: true } },
      assignee: true,
    },
  });
  return applyAssignee(user, rows, assigneeId, ids.length - rows.length);
}

// --- Assignee (dashboard: whole engagement-periods) ---------------------------------

export type EngagementPeriodRef = { clientId: string; projectId: string; instance?: number; periodName: string };

// Reassigns the OPEN steps of each selected dashboard row. Done steps keep the
// person who did them — reassigning finished work would rewrite who is
// credited with it. `onlyUnassigned` fills blanks without touching steps
// somebody has already picked up.
export async function bulkAssignEngagements(
  refs: EngagementPeriodRef[],
  employeeId: string,
  options: { onlyUnassigned?: boolean } = {}
): Promise<BulkResult> {
  const user = await requireUser();
  const assigneeId = employeeId || null;
  await assertEmployeeExists(assigneeId);
  if (refs.length === 0) return { changed: 0, unchanged: 0, skipped: [] };
  if (refs.length > MAX_BULK) throw new Error(`Select at most ${MAX_BULK} rows at a time.`);

  const rows = await prisma.clientActivity.findMany({
    where: {
      status: { not: "DONE" },
      ...(options.onlyUnassigned ? { assigneeId: null } : {}),
      OR: refs.map((r) => ({
        clientId: r.clientId,
        projectId: r.projectId,
        instance: r.instance ?? 1,
        periodName: r.periodName,
      })),
    },
    include: {
      subTask: { select: { name: true } },
      client: { select: { companyName: true } },
      project: { select: { name: true } },
      assignee: true,
    },
  });
  return applyAssignee(user, rows, assigneeId, 0);
}

type AssignableRow = {
  id: string;
  clientId: string;
  projectId: string;
  instance: number;
  periodName: string;
  assigneeId: string | null;
  assignee: { firstName: string; lastName: string } | null;
  subTask: { name: string };
  client: { companyName: string };
  project: { name: string };
};

async function applyAssignee(
  user: CurrentUser,
  rows: AssignableRow[],
  assigneeId: string | null,
  missing: number
): Promise<BulkResult> {
  const canAccess = accessChecker(user);
  const skipped: BulkResult["skipped"] = [];
  for (let i = 0; i < missing; i += 1) skipped.push({ label: "A task", reason: "That task no longer exists." });

  const allowed: AssignableRow[] = [];
  for (const r of rows) {
    if (await canAccess(r.clientId, r.projectId, r.instance)) allowed.push(r);
    else skipped.push({ label: `${r.client.companyName} · ${r.subTask.name}`, reason: NO_ACCESS });
  }
  const changing = allowed.filter((r) => r.assigneeId !== assigneeId);

  if (changing.length > 0) {
    await prisma.clientActivity.updateMany({
      where: { id: { in: changing.map((r) => r.id) } },
      data: { assigneeId },
    });
    const who = assigneeId ? await prisma.employee.findUnique({ where: { id: assigneeId } }) : null;
    await recordAuditMany(
      changing.map((r) => ({
        entityType: "ClientActivity",
        entityId: r.id,
        action: AUDIT.ASSIGNEE_CHANGED,
        summary: `${r.subTask.name}: ${name(r.assignee)} → ${name(who)} (bulk)`,
        fromValue: r.assigneeId,
        toValue: assigneeId,
        clientId: r.clientId,
        projectId: r.projectId,
        instance: r.instance,
        periodName: r.periodName,
        contextLabel: `${r.client.companyName} · ${r.project.name}`,
        actor: actorFrom(user),
      }))
    );
  }

  revalidateBulk(new Set(allowed.map(groupKey)));
  return { changed: changing.length, unchanged: allowed.length - changing.length, skipped };
}
