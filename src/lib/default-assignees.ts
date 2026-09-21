// Default assignees.
//
// Before this, every period that rolled forward arrived completely unassigned,
// so somebody hand-assigned the same people to the same steps every single
// month. The bulk-assign panel on the assignment page was a workaround for
// exactly that.
//
// Two layers, and the precedence between them is the whole design decision:
//
//   ProjectTaskMap.defaultAssigneeId    — "Reviewer Layer 2 is always Marcus"
//   ProjectClientMap.defaultAssigneeId  — "Priya owns Bluepoint's bookkeeping"
//
// The STEP default wins where it is set; the ENGAGEMENT default fills in
// everything else. The step default expresses a role or a skill — the person
// who does second review is the person who does second review, regardless of
// whose client it is — while the engagement default is the catch-all owner.
// Resolving it the other way round would let a client owner silently take over
// a specialist sign-off step, which is the opposite of what a reviewer layer
// is for.
//
// Neither layer is retroactive: changing a default affects rows generated from
// then on (a new engagement, the next period), never rows that already exist.
// Reassigning live work is a different action with different consequences, and
// the assignment page already has one. `applyDefaultAssignees` is the explicit,
// opt-in way to push defaults onto an existing period.

export type StepDefault = { subTaskId: string; defaultAssigneeId: string | null };

// Resolves who each step should go to, given both layers. Steps with no
// applicable default are simply absent from the map — callers leave those
// unassigned rather than guessing.
export function resolveDefaultAssignees(input: {
  steps: StepDefault[];
  engagementDefaultId: string | null | undefined;
}): Map<string, string> {
  const resolved = new Map<string, string>();
  for (const step of input.steps) {
    const who = step.defaultAssigneeId ?? input.engagementDefaultId ?? null;
    if (who) resolved.set(step.subTaskId, who);
  }
  return resolved;
}

// One-line explanation of where a step's assignee came from, for the checklist
// builder and the engagement panel.
export function describeDefaultSource(
  stepDefaultId: string | null,
  engagementDefaultId: string | null,
  nameOf: (id: string) => string | undefined
): string {
  if (stepDefaultId) return `Always ${nameOf(stepDefaultId) ?? "someone"}`;
  if (engagementDefaultId) return `${nameOf(engagementDefaultId) ?? "Engagement owner"} (engagement)`;
  return "Unassigned";
}
