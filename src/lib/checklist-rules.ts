// The rules for a project's checklist order. Pure — no Prisma, no next/* — so
// scripts/test-checklist.ts can exercise them directly. src/lib/checklist.ts
// applies them to the database.
//
// Steps are numbered 1, 2, 3… with no gaps. Inserting a step at position 5
// makes it number 5 and moves everything from the old 5 onward down one.
// Every project owns its own steps, including its own "Completed Y/N".

export function planChecklist(
  current: string[],
  options: { insert?: { id: string; position: number } } = {}
): string[] {
  const { insert } = options;
  const work = current.filter((id) => id !== insert?.id);
  if (insert) {
    const at = Math.max(0, Math.min(work.length, Math.trunc(insert.position) - 1));
    work.splice(Number.isFinite(at) ? at : work.length, 0, insert.id);
  }
  return work;
}

// May a step inserted at `position` be added to a period that's already under
// way? Only if the work hasn't got past that point: if any step that now comes
// after it is already done, adding an open step in front of it would break the
// rule that steps are finished in order.
export function canAddToOpenPeriod(
  rows: { position: number; done: boolean }[],
  position: number
): boolean {
  return !rows.some((r) => r.position >= position && r.done);
}

// One client's full checklist for an engagement: the project's template steps
// with that client's own steps woven in. Each client step sits straight after
// the step it was inserted behind (`after`, null = first), so it travels with
// that step when the template is reordered. Client steps are applied oldest
// first; a newer one inserted at the same spot lands in front of an older one,
// exactly where it was put. A client step whose anchor is gone goes last.
export function engagementOrder(
  template: string[],
  clientSteps: { id: string; after: string | null }[]
): string[] {
  const order = [...template];
  for (const step of clientSteps) {
    if (order.includes(step.id)) continue;
    if (step.after === null) {
      order.unshift(step.id);
      continue;
    }
    const at = order.indexOf(step.after);
    if (at === -1) order.push(step.id);
    else order.splice(at + 1, 0, step.id);
  }
  return order;
}

// Names the per-project "Completed Y/N" step goes by. Used only by the data
// upgrade that undoes the short-lived shared version of it.
export function isCompletedStepName(name: string): boolean {
  const n = name.trim().toLowerCase().replace(/[^a-z]/g, "");
  return n === "completedyn" || n === "completed" || n === "complete";
}
