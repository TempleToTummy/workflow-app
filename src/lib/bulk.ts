import type { ActivityStatus } from "@prisma/client";
import { canMarkDone } from "@/lib/workflow";

// Planning a bulk status change. Pure (no next/*, no Prisma) — covered by
// scripts/test-bulk.ts.
//
// The one rule that makes this more than an updateMany is sequential
// completion: a step can't be Done while an earlier step in the same
// client/project/period is open. A bulk "mark done" has to honour that
// exactly as the single-step action does, but it also has to be useful: if
// someone selects steps 1, 2 and 3 of the same engagement, all three should
// go through, because by the time step 3 is considered, 1 and 2 are done.
// So each engagement-period is simulated in sequence order, and anything
// still blocked is skipped with the name of the step blocking it, rather than
// failing the whole batch or silently leaving it.

export type PlannableTask = {
  id: string;
  // client:project:period — the scope of the sequential rule.
  groupKey: string;
  taskSeqNo: number;
  status: ActivityStatus;
  label: string;
};

export type BulkStatusPlan = {
  // Ids to change, in the order they should be applied.
  apply: string[];
  // Selected but already at the target status.
  unchanged: string[];
  skipped: { id: string; reason: string }[];
};

export const MAX_BULK = 500;

export function planBulkStatus(
  selectedIds: string[],
  // Every task in every group that contains a selected task — the siblings are
  // needed to judge the sequential rule.
  tasks: PlannableTask[],
  newStatus: ActivityStatus
): BulkStatusPlan {
  const selected = new Set(selectedIds);
  const plan: BulkStatusPlan = { apply: [], unchanged: [], skipped: [] };

  const known = new Set(tasks.map((t) => t.id));
  for (const id of selected) {
    if (!known.has(id)) plan.skipped.push({ id, reason: "That task no longer exists." });
  }

  const groups = new Map<string, PlannableTask[]>();
  for (const t of tasks) groups.set(t.groupKey, [...(groups.get(t.groupKey) ?? []), t]);

  for (const group of groups.values()) {
    // Simulated statuses, so a step marked done earlier in this batch counts
    // as done for the steps after it.
    const sim = group
      .map((t) => ({ ...t }))
      .sort((a, b) => a.taskSeqNo - b.taskSeqNo);

    for (const task of sim) {
      if (!selected.has(task.id)) continue;
      if (task.status === newStatus) {
        plan.unchanged.push(task.id);
        continue;
      }
      if (newStatus === "DONE" && !canMarkDone(task, sim)) {
        const blocker = sim.find((s) => s.taskSeqNo < task.taskSeqNo && s.status !== "DONE");
        plan.skipped.push({
          id: task.id,
          reason: blocker
            ? `Waiting on an earlier step: ${blocker.label}.`
            : "An earlier step is still open.",
        });
        continue;
      }
      task.status = newStatus;
      plan.apply.push(task.id);
    }
  }

  return plan;
}

// "12 marked done · 3 already done · 2 skipped" — the one-line result the bulk
// bar shows.
export function describeBulkResult(input: {
  verb: string;
  changed: number;
  unchanged?: number;
  skipped: number;
}): string {
  const parts = [`${input.changed} ${input.verb}`];
  if (input.unchanged) parts.push(`${input.unchanged} already set`);
  if (input.skipped) parts.push(`${input.skipped} skipped`);
  return parts.join(" · ");
}
