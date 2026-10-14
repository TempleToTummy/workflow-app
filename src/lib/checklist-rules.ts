// The rules for a project's checklist order. Pure — no Prisma, no next/* — so
// scripts/test-checklist.ts can exercise them directly. src/lib/checklist.ts
// applies them to the database.
//
//   1. Steps are numbered 1, 2, 3… with no gaps. Inserting a step at position 5
//      makes it number 5 and moves everything from the old 5 onward down one.
//   2. The universal "Completed Y/N" step is always the last step of any
//      project that has at least one other step. It can't be moved above
//      anything or removed from one project on its own. A project with no
//      other steps doesn't get it (an empty template generates no work).

export const COMPLETED_KEY = "COMPLETED";
export const COMPLETED_NAME = "Completed Y/N";

// Names the old per-project copies went by. The upgrade folds every one of
// them into the single universal step.
export function isCompletedStepName(name: string): boolean {
  const n = name.trim().toLowerCase().replace(/[^a-z]/g, "");
  return n === "completedyn" || n === "completed" || n === "complete";
}

export function planChecklist(
  current: string[],
  options: {
    completedId: string | null;
    insert?: { id: string; position: number };
  }
): string[] {
  const { completedId, insert } = options;
  const work = current.filter((id) => id !== completedId && id !== insert?.id);
  if (insert) {
    const at = Math.max(0, Math.min(work.length, Math.trunc(insert.position) - 1));
    work.splice(Number.isFinite(at) ? at : work.length, 0, insert.id);
  }
  return completedId && work.length > 0 ? [...work, completedId] : work;
}

// A full reorder from the drag-and-drop list: whatever order the user dropped,
// the universal step goes back to the end.
export function enforceCompletedLast(ordered: string[], completedId: string | null): string[] {
  return planChecklist(ordered, { completedId });
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
