"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ActivityStatus } from "@prisma/client";
import { StatusBadge, STATUS_LABEL } from "@/components/status-badge";
import { BulkBar, BulkOutcome, bulkButtonClass, bulkSelectClass, useSelection } from "@/components/bulk-bar";
import { bulkAssignTasks, bulkUpdateTaskStatus, type BulkResult } from "@/lib/bulk-actions";
import { describeBulkResult } from "@/lib/bulk";
import { formatDueDate } from "@/lib/dates";

export type TaskRow = {
  id: string;
  clientId: string;
  projectId: string;
  clientName: string;
  projectName: string;
  step: string;
  status: ActivityStatus;
  assigneeName: string;
  dueDate: string | null;
  dueOverridden: boolean;
  urgency: "overdue" | "soon" | "normal";
};

function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

const STATUSES = Object.keys(STATUS_LABEL) as ActivityStatus[];

export function TasksTable({
  rows,
  employees,
}: {
  rows: TaskRow[];
  employees: { value: string; label: string }[];
}) {
  const router = useRouter();
  const sel = useSelection(rows.map((r) => r.id));
  const [status, setStatus] = useState<ActivityStatus | "">("");
  const [assignee, setAssignee] = useState<string>("");
  const [outcome, setOutcome] = useState<{ summary: string | null; skipped: BulkResult["skipped"]; error: string | null }>({
    summary: null,
    skipped: [],
    error: null,
  });
  const [isPending, startTransition] = useTransition();

  function run(action: () => Promise<BulkResult>, verb: string) {
    setOutcome({ summary: null, skipped: [], error: null });
    startTransition(async () => {
      try {
        const r = await action();
        setOutcome({
          summary: describeBulkResult({ verb, changed: r.changed, unchanged: r.unchanged, skipped: r.skipped.length }),
          skipped: r.skipped,
          error: null,
        });
        sel.clear();
        router.refresh();
      } catch (err) {
        setOutcome({ summary: null, skipped: [], error: err instanceof Error ? err.message : "That didn't work." });
      }
    });
  }

  return (
    <div>
      <BulkBar count={sel.selectedIds.length} noun={["task", "tasks"]} onClear={sel.clear}>
        <div className="flex items-center gap-1.5">
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as ActivityStatus | "")}
            aria-label="New status"
            className={bulkSelectClass}
          >
            <option value="">Set status…</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={isPending || !status}
            onClick={() =>
              status &&
              run(
                () => bulkUpdateTaskStatus(sel.selectedIds, status),
                `set to ${STATUS_LABEL[status].toLowerCase()}`
              )
            }
            className={bulkButtonClass}
          >
            Apply
          </button>
        </div>
        <div className="flex items-center gap-1.5">
          <select
            value={assignee}
            onChange={(e) => setAssignee(e.target.value)}
            aria-label="Assign to"
            className={bulkSelectClass}
          >
            <option value="">Assign to…</option>
            <option value="__unassign">Nobody (unassign)</option>
            {employees.map((e) => (
              <option key={e.value} value={e.value}>
                {e.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={isPending || !assignee}
            onClick={() =>
              run(
                () => bulkAssignTasks(sel.selectedIds, assignee === "__unassign" ? "" : assignee),
                assignee === "__unassign" ? "unassigned" : "reassigned"
              )
            }
            className={bulkButtonClass}
          >
            Assign
          </button>
        </div>
        {isPending && <span className="text-xs text-ink-muted">Working…</span>}
      </BulkBar>
      <BulkOutcome {...outcome} />

      <div className="overflow-hidden rounded-lg border border-line bg-surface shadow-sm">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-line bg-black/[0.02] text-xs uppercase tracking-wide text-ink-muted">
              <th className="no-print w-10 px-4 py-3">
                <input
                  type="checkbox"
                  checked={sel.allSelected}
                  onChange={sel.toggleAll}
                  aria-label={sel.allSelected ? "Deselect all tasks" : "Select all tasks shown"}
                />
              </th>
              <th className="px-4 py-3 font-medium">Client</th>
              <th className="px-4 py-3 font-medium">Project</th>
              <th className="px-4 py-3 font-medium">Step</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Assignee</th>
              <th className="px-4 py-3 font-medium">Due</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.id}
                className={`border-b border-line last:border-0 hover:bg-black/[0.015] ${
                  sel.isSelected(r.id) ? "bg-accent-soft/50" : ""
                }`}
              >
                <td className="no-print px-4 py-3">
                  <input
                    type="checkbox"
                    checked={sel.isSelected(r.id)}
                    onChange={() => sel.toggle(r.id)}
                    aria-label={`Select ${r.clientName} · ${r.projectName} · ${r.step}`}
                  />
                </td>
                <td className="px-4 py-3 align-middle text-ink-muted">{r.clientName}</td>
                <td className="px-4 py-3 align-middle text-ink-muted">{r.projectName}</td>
                <td className="px-4 py-3 align-middle">
                  <Link
                    href={`/assignments/${r.clientId}/${r.projectId}`}
                    className="font-medium text-ink hover:text-accent"
                  >
                    {r.step}
                  </Link>
                </td>
                <td className="px-4 py-3 align-middle">
                  <StatusBadge status={r.status} />
                </td>
                <td className="px-4 py-3 align-middle">
                  <div className="flex items-center gap-2 text-ink-muted">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[10px] font-medium text-accent">
                      {initials(r.assigneeName)}
                    </span>
                    {r.assigneeName}
                  </div>
                </td>
                <td
                  className={`tabular px-4 py-3 align-middle ${
                    r.urgency === "overdue"
                      ? "font-medium text-overdue"
                      : r.urgency === "soon"
                      ? "font-medium text-[var(--status-review)]"
                      : "text-ink-muted"
                  }`}
                >
                  {formatDueDate(r.dueDate ? new Date(r.dueDate) : null)}
                  {r.dueOverridden && (
                    <span
                      title="This date was set by hand and won't change when the service's due-date rule changes."
                      className="ml-1 text-ink-muted"
                    >
                      *
                    </span>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-ink-muted">
                  No tasks match these filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {rows.length > 0 && (
        <p className="no-print mt-2 text-xs text-ink-muted">
          Tip: select several tasks to change their status or assignee at once. Marking steps done in bulk
          follows the same order rule as the checklist — earlier steps first.
        </p>
      )}
    </div>
  );
}
