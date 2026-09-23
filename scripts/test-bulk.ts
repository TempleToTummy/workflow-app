// Bulk status planning: the sequential-completion rule applied across many
// selected steps at once. No framework, no database:
//
//   ./node_modules/.bin/tsx scripts/test-bulk.ts
import { planBulkStatus, describeBulkResult, type PlannableTask } from "../src/lib/bulk";
import { check, section, finish } from "./harness";

type S = PlannableTask["status"];
const t = (id: string, seq: number, status: S, group = "c1:p1:2026-09"): PlannableTask => ({
  id,
  groupKey: group,
  taskSeqNo: seq,
  status,
  label: `Step ${id}`,
});

section("mark done — sequential rule inside one engagement");
{
  const tasks = [t("a", 10, "NOT_STARTED"), t("b", 20, "NOT_STARTED"), t("c", 30, "NOT_STARTED")];
  const all = planBulkStatus(["a", "b", "c"], tasks, "DONE");
  check("selecting 1, 2 and 3 applies all three", all.apply, ["a", "b", "c"]);
  check("…in sequence order", all.skipped, []);

  const gap = planBulkStatus(["a", "c"], tasks, "DONE");
  check("selecting 1 and 3 applies 1", gap.apply, ["a"]);
  check("…and skips 3, naming the blocking step", gap.skipped, [
    { id: "c", reason: "Waiting on an earlier step: Step b." },
  ]);

  const reversed = planBulkStatus(["c", "b", "a"], tasks, "DONE");
  check("selection order doesn't matter", reversed.apply, ["a", "b", "c"]);

  const onlyLast = planBulkStatus(["c"], tasks, "DONE");
  check("a later step alone is blocked", onlyLast.apply, []);
  check("…by the FIRST open earlier step", onlyLast.skipped[0].reason, "Waiting on an earlier step: Step a.");
}

section("mark done — already-done and unselected siblings");
{
  const tasks = [t("a", 10, "DONE"), t("b", 20, "IN_PROGRESS"), t("c", 30, "NOT_STARTED")];
  const p = planBulkStatus(["a", "b"], tasks, "DONE");
  check("already-done step is reported unchanged", p.unchanged, ["a"]);
  check("the next step goes through", p.apply, ["b"]);
  const q = planBulkStatus(["c"], [t("a", 10, "DONE"), t("b", 20, "AWAITING_REVIEW"), t("c", 30, "NOT_STARTED")], "DONE");
  check("an unselected open sibling still blocks", q.apply, []);
}

section("mark done — several engagements are independent");
{
  const tasks = [
    t("a1", 10, "NOT_STARTED", "c1:p1:2026-09"),
    t("a2", 20, "NOT_STARTED", "c1:p1:2026-09"),
    t("b1", 10, "DONE", "c2:p1:2026-09"),
    t("b2", 20, "NOT_STARTED", "c2:p1:2026-09"),
  ];
  const p = planBulkStatus(["a2", "b2"], tasks, "DONE");
  check("a blocked row in one engagement doesn't stop another", p.apply, ["b2"]);
  check("…and the blocked one is explained", p.skipped.map((s) => s.id), ["a2"]);
}

section("other statuses have no ordering rule");
{
  const tasks = [t("a", 10, "NOT_STARTED"), t("b", 20, "DONE"), t("c", 30, "IN_PROGRESS")];
  const p = planBulkStatus(["b", "c"], tasks, "IN_PROGRESS");
  check("re-opening a done step is allowed", p.apply, ["b"]);
  check("a step already at the target is unchanged", p.unchanged, ["c"]);
  check("nothing skipped", p.skipped, []);
}

section("robustness");
{
  const p = planBulkStatus(["ghost"], [t("a", 10, "NOT_STARTED")], "DONE");
  check("an id that no longer exists is skipped, not thrown", p.skipped, [
    { id: "ghost", reason: "That task no longer exists." },
  ]);
  check("empty selection → empty plan", planBulkStatus([], [t("a", 10, "NOT_STARTED")], "DONE"), {
    apply: [],
    unchanged: [],
    skipped: [],
  });
}

section("describeBulkResult");
check("all parts", describeBulkResult({ verb: "marked done", changed: 3, unchanged: 1, skipped: 2 }), "3 marked done · 1 already set · 2 skipped");
check("zeros are left out", describeBulkResult({ verb: "reassigned", changed: 5, unchanged: 0, skipped: 0 }), "5 reassigned");

finish();
