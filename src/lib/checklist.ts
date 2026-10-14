import { prisma } from "@/lib/prisma";
import { openPeriodForAssignment } from "@/lib/scheduler";
import {
  COMPLETED_KEY,
  COMPLETED_NAME,
  canAddToOpenPeriod,
  planChecklist,
} from "@/lib/checklist-rules";

// Applies src/lib/checklist-rules.ts to the database. Every change to a
// project's checklist — add, insert, remove, reorder — ends in
// normalizeChecklist, so the numbering, the universal "Completed Y/N" step
// and the periods already in progress can never drift apart.
//
// Not a "use server" module: these helpers do no access checking of their
// own, and exporting them from one would publish them as endpoints.

export { COMPLETED_KEY, COMPLETED_NAME };

// The one shared "Completed Y/N" step, created the first time it's needed.
export async function ensureCompletedStep(): Promise<string> {
  const existing = await prisma.projectSubTask.findUnique({
    where: { systemKey: COMPLETED_KEY },
    select: { id: true },
  });
  if (existing) return existing.id;
  const created = await prisma.projectSubTask.create({
    data: { name: COMPLETED_NAME, systemKey: COMPLETED_KEY },
  });
  return created.id;
}

export async function completedStepId(): Promise<string | null> {
  const row = await prisma.projectSubTask.findUnique({
    where: { systemKey: COMPLETED_KEY },
    select: { id: true },
  });
  return row?.id ?? null;
}

export type NormalizeResult = {
  // How many in-progress periods received a newly inserted step.
  addedToOpenPeriods: number;
  // …and how many were left alone because their work was already past it.
  skippedOpenPeriods: number;
};

// Renumbers the project's checklist 1..n with the universal step last, then
// brings every period that's still in progress into line with it.
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
  const current = options.orderedIds ?? maps.map((m) => m.subTaskId);
  const completedId =
    current.length > 0 || options.insert ? await ensureCompletedStep() : await completedStepId();

  const ordered = planChecklist(current, { completedId, insert: options.insert });

  // Make sure the universal step is actually on the project (it may have been
  // added just now by planChecklist) and every row has its new number.
  const onProject = new Set(maps.map((m) => m.subTaskId));
  const sequenceOf = new Map(ordered.map((id, i) => [id, i + 1]));
  // The only step planChecklist ever drops is the universal one, when nothing
  // else is left on the project. Rows already generated from it stay.
  const dropped = maps.filter((m) => !sequenceOf.has(m.subTaskId)).map((m) => m.subTaskId);
  await prisma.$transaction([
    ...dropped.map((subTaskId) =>
      prisma.projectTaskMap.delete({ where: { projectId_subTaskId: { projectId, subTaskId } } })
    ),
    ...ordered
      .filter((id) => !onProject.has(id))
      .map((subTaskId) =>
        prisma.projectTaskMap.create({ data: { projectId, subTaskId, sequence: sequenceOf.get(subTaskId)! } })
      ),
    ...maps
      .filter((m) => sequenceOf.has(m.subTaskId) && m.sequence !== sequenceOf.get(m.subTaskId))
      .map((m) =>
        prisma.projectTaskMap.update({
          where: { projectId_subTaskId: { projectId, subTaskId: m.subTaskId } },
          data: { sequence: sequenceOf.get(m.subTaskId)! },
        })
      ),
  ]);

  return syncOpenPeriods(projectId, sequenceOf, options.insert?.id ?? null, options.actor);
}

// Periods still in progress follow the template's numbering. Finished periods
// are history and keep the numbers they were done under.
async function syncOpenPeriods(
  projectId: string,
  sequenceOf: Map<string, number>,
  insertedId: string | null,
  actor?: { id: string | null; label: string }
): Promise<NormalizeResult> {
  const rows = await prisma.clientActivity.findMany({
    where: { projectId },
    select: { id: true, clientId: true, periodName: true, subTaskId: true, status: true, taskSeqNo: true },
  });
  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = `${r.clientId}\u0000${r.periodName}`;
    const list = groups.get(key);
    if (list) list.push(r);
    else groups.set(key, [r]);
  }

  const updates: { id: string; seq: number }[] = [];
  const addTo: { clientId: string; periodName: string }[] = [];
  let skipped = 0;
  const insertedSeq = insertedId ? sequenceOf.get(insertedId) ?? null : null;

  for (const group of groups.values()) {
    if (group.every((r) => r.status === "DONE")) continue;
    for (const r of group) {
      const seq = sequenceOf.get(r.subTaskId);
      if (seq !== undefined && seq !== r.taskSeqNo) updates.push({ id: r.id, seq });
    }
    if (insertedId && insertedSeq !== null && !group.some((r) => r.subTaskId === insertedId)) {
      const positions = group
        .filter((r) => sequenceOf.has(r.subTaskId))
        .map((r) => ({ position: sequenceOf.get(r.subTaskId)!, done: r.status === "DONE" }));
      if (canAddToOpenPeriod(positions, insertedSeq)) {
        addTo.push({ clientId: group[0].clientId, periodName: group[0].periodName });
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
      periodName: target.periodName,
      onlySubTaskIds: [insertedId!],
      actor,
    });
  }

  return { addedToOpenPeriods: addTo.length, skippedOpenPeriods: skipped };
}
