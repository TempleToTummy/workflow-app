// Checklist order: inserting between steps, numbering 1..n.
// No framework, no database:
//
//   ./node_modules/.bin/tsx scripts/test-checklist.ts
import { planChecklist, canAddToOpenPeriod, isCompletedStepName } from "../src/lib/checklist-rules";
import { check, section, finish } from "./harness";

const steps = ["s1", "s2", "s3", "s4", "s5", "s6", "done"];

section("inserting between steps");
// "I want to add a task between task 4 and 5": the new task becomes number 5
// and the old 5 onward each move down one.
{
  const out = planChecklist(steps, { insert: { id: "new", position: 5 } });
  check("the new task is number 5", out.indexOf("new") + 1, 5);
  check("everything after it moved down one", out, ["s1", "s2", "s3", "s4", "new", "s5", "s6", "done"]);
}
check("position 1 puts it first", planChecklist(steps, { insert: { id: "new", position: 1 } })[0], "new");
check("past the end goes last", planChecklist(steps, { insert: { id: "new", position: 99 } }).slice(-1), ["new"]);
check("zero or negative positions go first", planChecklist(["s1"], { insert: { id: "new", position: 0 } }), ["new", "s1"]);
check(
  "re-inserting an existing step moves it",
  planChecklist(["s1", "s2", "s3"], { insert: { id: "s3", position: 1 } }),
  ["s3", "s1", "s2"]
);
check("no insert → order unchanged", planChecklist(steps), steps);
check("the first step of an empty project", planChecklist([], { insert: { id: "s1", position: 1 } }), ["s1"]);

section("each project keeps its own Completed Y/N");
check("recognised for the upgrade that splits a shared one", ["Completed Y/N", "completed (y/n)", " Completed "].map(isCompletedStepName), [true, true, true]);
check("…but not other steps", ["Completed review", "Confirm 8879 signed"].map(isCompletedStepName), [false, false]);

section("adding to a period already under way");
// Steps 1–3 done, 4 in progress; inserting at 5 is fine, inserting at 2 isn't
// (step 3 is already done, so an open step 2 would break finish-in-order).
const rows = [
  { position: 1, done: true },
  { position: 2, done: true },
  { position: 3, done: true },
  { position: 4, done: false },
  { position: 6, done: false },
];
check("ahead of the work: added", canAddToOpenPeriod(rows, 5), true);
check("right at the step being worked: added", canAddToOpenPeriod(rows, 4), true);
check("behind finished work: not added", canAddToOpenPeriod(rows, 2), false);
check("a period that hasn't started: added anywhere", canAddToOpenPeriod([{ position: 1, done: false }], 1), true);

finish();
