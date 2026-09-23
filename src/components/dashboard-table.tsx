"use client";

import { Fragment, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ActivityStatus } from "@prisma/client";
import { StatusBadge } from "@/components/status-badge";
import { BulkBar, BulkOutcome, bulkButtonClass, bulkSelectClass, useSelection } from "@/components/bulk-bar";
import { bulkAssignEngagements, type BulkResult } from "@/lib/bulk-actions";
import { describeBulkResult } from "@/lib/bulk";
import { formatDueDate } from "@/lib/dates";

export type DashboardRow = {
  key: string;
  clientId: string;
  projectId: string;
  periodName: string;
  href: string;
  clientName: string;
  projectName: string;
  completed: boolean;
  status: ActivityStatus;
  progress: string;
  progressPct: number;
  dueDate: string | null;
  urgency: "overdue" | "soon" | "normal";
  assigneeName: string;
};

function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

export function DashboardTable({
  rows,
  completedCount,
  firstCompletedIndex,
  emptyMessage,
  employees,
}: {
  rows: DashboardRow[];
  completedCount: number;
  firstCompletedIndex: number;
  emptyMessage: string;
  employees: { value: string; label: string }[];
}) {
  const router = useRouter();
  // Completed rows have no open steps to reassign, so they aren't selectable.
  const selectable = rows.filter((r) => !r.completed);
  const sel = useSelection(selectable.map((r) => r.key));
  const [assignee, setAssignee] = useState("");
  const [onlyUnassigned, setOnlyUnassigned] = useState(false);
  const [outcome, setOutcome] = useState<{ summary: string | null; skipped: BulkResult["skipped"]; error: string | null }>({
    summary: null,
    skipped: [],
    error: null,
  });
  const [isPending, startTransition] = useTransition();

  function assign() {
    const refs = rows
      .filter((r) => sel.isSelected(r.key))
      .map((r) => ({ clientId: r.clientId, projectId: r.projectId, periodName: r.periodName }));
    const employeeId = assignee === "__unassign" ? "" : assignee;
    setOutcome({ summary: null, skipped: [], error: null });
    startTransition(async () => {
      try {
        const r = await bulkAssignEngagements(refs, employeeId, { onlyUnassigned });
        setOutcome({
          summary: describeBulkResult({
            verb: `open step${r.changed === 1 ? "" : "s"} ${employeeId ? "reassigned" : "unassigned"}`,
            changed: r.changed,
            unchanged: r.unchanged,
            skipped: r.skipped.length,
          }),
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
      <BulkBar count={sel.selectedIds.length} noun={["row", "rows"]} onClear={sel.clear}>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={assignee}
            onChange={(e) => setAssignee(e.target.value)}
            aria-label="Assign open steps to"
            className={bulkSelectClass}
          >
            <option value="">Assign open steps to…</option>
            <option value="__unassign">Nobody (unassign)</option>
            {employees.map((e) => (
              <option key={e.value} value={e.value}>
                {e.label}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1.5 text-xs text-ink-muted">
            <input type="checkbox" checked={onlyUnassigned} onChange={(e) => setOnlyUnassigned(e.target.checked)} />
            Only unassigned steps
          </label>
          <button type="button" disabled={isPending || !assignee} onClick={assign} className={bulkButtonClass}>
            {isPending ? "Working…" : "Assign"}
          </button>
        </div>
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
                  disabled={selectable.length === 0}
                  onChange={sel.toggleAll}
                  aria-label={sel.allSelected ? "Deselect all rows" : "Select all open rows shown"}
                />
              </th>
              <th className="px-4 py-3 font-medium">Client</th>
              <th className="px-4 py-3 font-medium">Project</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Assigned to</th>
              <th className="px-4 py-3 font-medium">Due</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <Fragment key={r.key}>
                {i === firstCompletedIndex && completedCount > 0 && (
                  <tr className="border-b border-line bg-black/[0.03]">
                    <td colSpan={6} className="px-4 py-2 text-[11px] font-medium uppercase tracking-wide text-ink-muted">
                      Completed · {completedCount}
                    </td>
                  </tr>
                )}
                <tr
                  className={`border-b border-line last:border-0 hover:bg-black/[0.015] ${
                    sel.isSelected(r.key) ? "bg-accent-soft/50" : r.completed ? "bg-black/[0.01]" : ""
                  }`}
                >
                  <td className="no-print px-4 py-4 align-middle">
                    {!r.completed && (
                      <input
                        type="checkbox"
                        checked={sel.isSelected(r.key)}
                        onChange={() => sel.toggle(r.key)}
                        aria-label={`Select ${r.clientName} · ${r.projectName} ${r.periodName}`}
                      />
                    )}
                  </td>
                  <td className="px-4 py-4 align-middle">
                    <Link
                      href={r.href}
                      className={`font-medium hover:text-accent ${r.completed ? "text-ink-muted" : "text-ink"}`}
                    >
                      {r.clientName}
                    </Link>
                  </td>
                  <td className="px-4 py-4 align-middle">
                    <div className="flex items-center gap-2">
                      <Link href={r.href} className="text-ink-muted hover:text-accent">
                        {r.projectName}
                      </Link>
                      <span className="tabular rounded-full bg-black/5 px-1.5 py-0.5 text-[10px] text-ink-muted">
                        {r.periodName}
                      </span>
                    </div>
                    <div className="mt-2 flex items-center gap-2">
                      <div className="h-1.5 w-28 overflow-hidden rounded-full bg-line">
                        <div
                          className={`h-full rounded-full ${r.completed ? "bg-accent/50" : "bg-accent"}`}
                          style={{ width: `${r.progressPct}%` }}
                        />
                      </div>
                      <span className="tabular text-[11px] text-ink-muted">{r.progress}</span>
                    </div>
                  </td>
                  <td className="px-4 py-4 align-middle">
                    <StatusBadge status={r.status} />
                  </td>
                  <td className="px-4 py-4 align-middle">
                    <div className="flex items-center gap-2 text-ink-muted">
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[10px] font-medium text-accent">
                        {initials(r.assigneeName)}
                      </span>
                      {r.assigneeName}
                    </div>
                  </td>
                  <td
                    className={`px-4 py-4 align-middle tabular ${
                      r.completed
                        ? "text-ink-muted"
                        : r.urgency === "overdue"
                        ? "font-medium text-overdue"
                        : r.urgency === "soon"
                        ? "font-medium text-[var(--status-review)]"
                        : "text-ink-muted"
                    }`}
                  >
                    {formatDueDate(r.dueDate ? new Date(r.dueDate) : null)}
                  </td>
                </tr>
              </Fragment>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-ink-muted">
                  {emptyMessage}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
