import { prisma } from "@/lib/prisma";
import { openPeriodForAssignment } from "@/lib/scheduler";
import { canAddToOpenPeriod, engagementOrder, planChecklist } from "@/lib/checklist-rules";

// Applies src/lib/checklist-rules.ts to the database. Every change to a
// project's checklist — add, insert, remove, reorder — ends in
// normalizeChecklist, so the numbering and the periods already in progress
// can never drift apart.
//
// Not a "use server" module: these helpers do no access checking of their
// own, and exporting them from one would publish them as endpoints.

export type NormalizeResult = {
  // How many in-progress periods received a newly inserted step.
  addedToOpenPeriods: number;
  // …and how many were left alone because their work was already past it.
  skippedOpenPeriods: number;
};

// Renumbers the project's checklist 1..n, then brings every period that's
// still in progress into line with it.
//
// `insert` places a step at a position (1-based). `orderedIds` replaces the
// whole order (drag and drop). Neither = just tidy what's there.
export async function normalizeChecklist(
  projectId: string,
  options: {
    insert?: { id: string; position: number };
    orderedIds?: string[];
    actor?: { id: string | null; label: string };
  } = {}
): Promise<NormalizeResult> {
  const maps = await prisma.projectTaskMap.findMany({
    where: { projectId },
    orderBy: { sequence: "asc" },
    select: { subTaskId: true, sequence: true },
  });
  const ordered = planChecklist(options.orderedIds ?? maps.map((m) => m.subTaskId), {
    insert: options.insert,
  });
  const sequenceOf = new Map(ordered.map((id, i) => [id, i + 1]));
  await prisma.$transaction(
    maps
      .filter((m) => sequenceOf.has(m.subTaskId) && m.sequence !== sequenceOf.get(m.subTaskId))
      .map((m) =>
        prisma.projectTaskMap.update({
          where: { projectId_subTaskId: { projectId, subTaskId: m.subTaskId } },
          data: { sequence: sequenceOf.get(m.subTaskId)! },
        })
      )
  );

  return syncOpenPeriods(projectId, sequenceOf, options.insert?.id ?? null, options.actor);
}

// Periods still in progress follow the template's numbering — with any
// client's own steps (src/lib/engagement-steps.ts) kept where they were put.
// Finished periods are history and keep the numbers they were done under.
async function syncOpenPeriods(
  projectId: string,
  sequenceOf: Map<string, number>,
  insertedId: string | null,
  actor?: { id: string | null; label: string }
): Promise<NormalizeResult> {
  const [rows, clientSteps] = await Promise.all([
    prisma.clientActivity.findMany({
      where: { projectId },
      select: { id: true, clientId: true, instance: true, periodName: true, subTaskId: true, status: true, taskSeqNo: true },
    }),
    prisma.projectSubTask.findMany({
      where: { projectId, clientId: { not: null } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, clientId: true, instance: true, afterSubTaskId: true },
    }),
  ]);
  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = `${r.clientId}\u0000${r.instance}\u0000${r.periodName}`;
    const list = groups.get(key);
    if (list) list.push(r);
    else groups.set(key, [r]);
  }

  // Each engagement's own order: the template, plus its client steps.
  const template = [...sequenceOf.keys()].sort((a, b) => sequenceOf.get(a)! - sequenceOf.get(b)!);
  const orderCache = new Map<string, Map<string, number>>();
  function rankFor(clientId: string, instance: number): Map<string, number> {
    const k = `${clientId}:${instance}`;
    let rank = orderCache.get(k);
    if (!rank) {
      const own = clientSteps
        .filter((c) => c.clientId === clientId && c.instance === instance)
        .map((c) => ({ id: c.id, after: c.afterSubTaskId }));
      rank = new Map(engagementOrder(template, own).map((id, i) => [id, i + 1]));
      orderCache.set(k, rank);
    }
    return rank;
  }

  const updates: { id: string; seq: number }[] = [];
  const addTo: { clientId: string; instance: number; periodName: string }[] = [];
  let skipped = 0;

  for (const group of groups.values()) {
    if (group.every((r) => r.status === "DONE")) continue;
    const rank = rankFor(group[0].clientId, group[0].instance);
    const hasClientSteps = group.some((r) => !sequenceOf.has(r.subTaskId));
    if (hasClientSteps) {
      // Pack 1..n in the engagement's order.
      const sorted = [...group].sort(
        (a, b) => (rank.get(a.subTaskId) ?? 1e9) - (rank.get(b.subTaskId) ?? 1e9) || a.taskSeqNo - b.taskSeqNo
      );
      sorted.forEach((r, i) => {
        if (r.taskSeqNo !== i + 1) updates.push({ id: r.id, seq: i + 1 });
      });
    } else {
      for (const r of group) {
        const seq = sequenceOf.get(r.subTaskId);
        if (seq !== undefined && seq !== r.taskSeqNo) updates.push({ id: r.id, seq });
      }
    }
    const insertedRank = insertedId ? rank.get(insertedId) ?? null : null;
    if (insertedId && insertedRank !== null && !group.some((r) => r.subTaskId === insertedId)) {
      const positions = group
        .filter((r) => rank.has(r.subTaskId))
        .map((r) => ({ position: rank.get(r.subTaskId)!, done: r.status === "DONE" }));
      if (canAddToOpenPeriod(positions, insertedRank)) {
        addTo.push({ clientId: group[0].clientId, instance: group[0].instance, periodName: group[0].periodName });
      } else {
        skipped += 1;
      }
    }
  }

  if (updates.length > 0) {
    await prisma.$transaction(
      updates.map((u) => prisma.clientActivity.update({ where: { id: u.id }, data: { taskSeqNo: u.seq } }))
    );
  }

  for (const target of addTo) {
    await openPeriodForAssignment({
      clientId: target.clientId,
      projectId,
      instance: target.instance,
      periodName: target.periodName,
      onlySubTaskIds: [insertedId!],
      actor,
    });
  }

  return { addedToOpenPeriods: addTo.length, skippedOpenPeriods: skipped };
}
