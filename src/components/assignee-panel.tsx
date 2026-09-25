"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { bulkAssignActivities, type BulkAssignTarget } from "@/lib/actions";

type Employee = { id: string; name: string };
type Step = { id: string; name: string; assigneeId: string | null };

export function AssigneePanel({
  clientId,
  projectId,
  periodName,
  steps,
  employees,
}: {
  clientId: string;
  projectId: string;
  periodName: string | null;
  steps: Step[];
  employees: Employee[];
}) {
  const [employeeId, setEmployeeId] = useState("");
  const [mode, setMode] = useState<"unassigned" | "selected">("unassigned");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  const nameById = useMemo(
    () => new Map(employees.map((e) => [e.id, e.name])),
    [employees]
  );

  const roster = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of steps) {
      const key = s.assigneeId ?? "";
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([id, count]) => ({
        id,
        label: id ? (nameById.get(id) ?? "Unknown") : "Unassigned",
        count,
      }))
      .sort((a, b) => (a.id === "" ? 1 : b.id === "" ? -1 : a.label.localeCompare(b.label)));
  }, [steps, nameById]);

  const unassignedCount = steps.filter((s) => !s.assigneeId).length;

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleAssign() {
    if (!periodName) return;
    setMessage(null);
    setError(null);
    const target: BulkAssignTarget =
      mode === "unassigned"
        ? { mode: "unassigned" }
        : { mode: "selected", activityIds: [...selected] };
    startTransition(async () => {
      try {
        const count = await bulkAssignActivities(
          clientId,
          projectId,
          periodName,
          employeeId,
          target
        );
        const who = employeeId ? (nameById.get(employeeId) ?? "someone") : "Unassigned";
        setMessage(
          count === 0
            ? "No steps matched — nothing changed."
            : `${who} → ${count} step${count === 1 ? "" : "s"}.`
        );
        setSelected(new Set());
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't assign.");
      }
    });
  }

  const canAssign =
    !!periodName &&
    !isPending &&
    (mode === "unassigned" ? unassignedCount > 0 : selected.size > 0);

  return (
    <div className="rounded-lg border border-line bg-surface p-4">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
        Assignees
      </h2>

      <ul className="mt-3 flex flex-col gap-1.5 text-sm">
        {roster.map((r) => (
          <li key={r.id || "none"} className="flex items-center justify-between gap-2">
            <span className={r.id ? "text-ink" : "text-ink-muted"}>{r.label}</span>
            <span className="tabular text-xs text-ink-muted">{r.count}</span>
          </li>
        ))}
      </ul>

      <div className="mt-4 border-t border-line pt-4">
        {!periodName ? (
          <p className="text-xs text-ink-muted">
            No active period — nothing to assign yet.
          </p>
        ) : (
          <>
            <label className="block text-xs font-medium text-ink-muted">
              Assign
              <select
                value={employeeId}
                disabled={isPending}
                onChange={(e) => setEmployeeId(e.target.value)}
                className="mt-1 w-full rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40"
              >
                <option value="">— Unassign —</option>
                {employees.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </select>
            </label>

            <div className="mt-3 flex flex-col gap-1.5 text-sm">
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="assign-mode"
                  checked={mode === "unassigned"}
                  onChange={() => setMode("unassigned")}
                  className="accent-[var(--accent)]"
                />
                <span>All unassigned ({unassignedCount})</span>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="assign-mode"
                  checked={mode === "selected"}
                  onChange={() => setMode("selected")}
                  className="accent-[var(--accent)]"
                />
                <span>Selected steps ({selected.size})</span>
              </label>
            </div>

            {mode === "selected" && (
              <ul className="mt-2 flex max-h-52 flex-col gap-1 overflow-y-auto rounded-md border border-line p-2">
                {steps.map((s) => (
                  <li key={s.id}>
                    <label className="flex items-start gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={selected.has(s.id)}
                        onChange={() => toggle(s.id)}
                        className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent)]"
                      />
                      <span className="min-w-0">
                        <span className="text-ink">{s.name}</span>
                        {s.assigneeId && (
                          <span className="block text-[11px] text-ink-muted">
                            {nameById.get(s.assigneeId) ?? "Assigned"}
                          </span>
                        )}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}

            <button
              type="button"
              onClick={handleAssign}
              disabled={!canAssign}
              className="mt-3 w-full whitespace-nowrap rounded-full bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {isPending ? "Assigning…" : "Assign"}
            </button>

            {message && <p className="mt-2 text-xs text-ink-muted">{message}</p>}
            {error && <p className="mt-2 text-xs text-overdue">{error}</p>}
          </>
        )}
      </div>
    </div>
  );
}
