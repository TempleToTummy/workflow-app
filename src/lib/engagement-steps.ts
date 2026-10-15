import { prisma } from "@/lib/prisma";
import { engagementOrder } from "@/lib/checklist-rules";
import { engagementWhere, type EngagementKey } from "@/lib/engagements";

// Client steps: checklist steps that belong to one engagement only — "for
// Bluepoint Bakery's bookkeeping, also get the bank loan statement" — without
// touching the project's template or any other client. Stored as a
// ProjectSubTask carrying the engagement's key (see prisma/schema.prisma);
// `repeats` says whether every later period gets it too.
//
// Not a "use server" module: no access checks here (src/lib/actions.ts does
// them), and exporting these from one would publish them as endpoints.

export type ClientStep = { id: string; after: string | null; repeats: boolean };

export function clientStepsWhere(key: EngagementKey) {
  return { clientId: key.clientId, projectId: key.projectId, instance: key.instance };
}

export async function clientStepsFor(key: EngagementKey): Promise<ClientStep[]> {
  const rows = await prisma.projectSubTask.findMany({
    where: clientStepsWhere(key),
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, afterSubTaskId: true, repeats: true },
  });
  return rows.map((r) => ({ id: r.id, after: r.afterSubTaskId, repeats: r.repeats }));
}

// The engagement's whole order: template steps with its client steps woven in.
export async function engagementStepOrder(
  key: EngagementKey,
  clientSteps?: ClientStep[]
): Promise<string[]> {
  const [maps, steps] = await Promise.all([
    prisma.projectTaskMap.findMany({
      where: { projectId: key.projectId },
      orderBy: { sequence: "asc" },
      select: { subTaskId: true },
    }),
    clientSteps ? Promise.resolve(clientSteps) : clientStepsFor(key),
  ]);
  return engagementOrder(
    maps.map((m) => m.subTaskId),
    steps
  );
}

// Numbers one period's rows 1, 2, 3… in the engagement's order. Rows the order
// doesn't know (shouldn't happen) keep their relative place at the end.
export async function renumberPeriod(key: EngagementKey, periodName: string, order?: string[]) {
  const full = order ?? (await engagementStepOrder(key));
  const rank = new Map(full.map((id, i) => [id, i]));
  const rows = await prisma.clientActivity.findMany({
    where: { ...engagementWhere(key), periodName },
    select: { id: true, subTaskId: true, taskSeqNo: true },
  });
  const sorted = [...rows].sort(
    (a, b) =>
      (rank.get(a.subTaskId) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.subTaskId) ?? Number.MAX_SAFE_INTEGER) ||
      a.taskSeqNo - b.taskSeqNo
  );
  const changes = sorted
    .map((r, i) => ({ id: r.id, seq: i + 1, was: r.taskSeqNo }))
    .filter((r) => r.seq !== r.was);
  if (changes.length === 0) return;
  await prisma.$transaction(
    changes.map((c) => prisma.clientActivity.update({ where: { id: c.id }, data: { taskSeqNo: c.seq } }))
  );
}
