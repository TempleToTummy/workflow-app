// Checklist order: inserting between steps, the universal final step.
// No framework, no database:
//
//   ./node_modules/.bin/tsx scripts/test-checklist.ts
import {
  planChecklist,
  enforceCompletedLast,
  canAddToOpenPeriod,
  isCompletedStepName,
} from "../src/lib/checklist-rules";
import { check, section, finish } from "./harness";

const steps = ["s1", "s2", "s3", "s4", "s5", "s6"];
const C = "completed";

section("inserting between steps");
// "I want to add a task between task 4 and 5": the new task becomes number 5
// and the old 5 onward each move down one.
{
  const out = planChecklist([...steps, C], { completedId: C, insert: { id: "new", position: 5 } });
  check("the new task is number 5", out.indexOf("new") + 1, 5);
  check("everything after it moved down one", out, ["s1", "s2", "s3", "s4", "new", "s5", "s6", C]);
}
check("position 1 puts it first", planChecklist([...steps, C], { completedId: C, insert: { id: "new", position: 1 } })[0], "new");
check(
  "past the end lands just above Completed",
  planChecklist([...steps, C], { completedId: C, insert: { id: "new", position: 99 } }).slice(-2),
  ["new", C]
);
check(
  "a position at Completed's own slot still goes above it",
  planChecklist(["s1", "s2", C], { completedId: C, insert: { id: "new", position: 3 } }),
  ["s1", "s2", "new", C]
);
check(
  "zero or negative positions go first",
  planChecklist(["s1", C], { completedId: C, insert: { id: "new", position: 0 } }),
  ["new", "s1", C]
);
check(
  "re-inserting an existing step moves it",
  planChecklist(["s1", "s2", "s3", C], { completedId: C, insert: { id: "s3", position: 1 } }),
  ["s3", "s1", "s2", C]
);

section("the universal Completed step");
check("added to a project's first step", planChecklist([], { completedId: C, insert: { id: "s1", position: 1 } }), ["s1", C]);
check("never on an empty project", planChecklist([C], { completedId: C }), []);
check("dragged to the top, it goes back to the end", enforceCompletedLast([C, "s1", "s2"], C), ["s1", "s2", C]);
check("dragged into the middle, the same", enforceCompletedLast(["s1", C, "s2"], C), ["s1", "s2", C]);
check("a project missing it gets it", enforceCompletedLast(["s1", "s2"], C), ["s1", "s2", C]);
check("no universal step yet → left alone", enforceCompletedLast(["s1", "s2"], null), ["s1", "s2"]);
check("old copies are recognised", ["Completed Y/N", "completed (y/n)", " Completed ", "Complete"].map(isCompletedStepName), [true, true, true, true]);
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
