"use client";

import { useState, type ReactNode } from "react";

// The sticky strip that appears over a list once rows are selected. Shared by
// the Tasks list and the dashboard; each supplies its own controls.
export function BulkBar({
  count,
  noun,
  onClear,
  children,
}: {
  count: number;
  noun: [string, string];
  onClear: () => void;
  children: ReactNode;
}) {
  if (count === 0) return null;
  return (
    <div
      role="region"
      aria-label="Bulk actions"
      className="no-print sticky top-0 z-10 mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-accent/30 bg-accent-soft px-4 py-2.5 shadow-sm"
    >
      <span className="text-sm font-medium text-accent">
        {count} {count === 1 ? noun[0] : noun[1]} selected
      </span>
      {children}
      <button
        type="button"
        onClick={onClear}
        className="ml-auto text-sm text-ink-muted underline decoration-dotted underline-offset-2 hover:text-ink"
      >
        Clear selection
      </button>
    </div>
  );
}

// The outcome of a bulk action: one summary line, and the skipped rows with
// their reasons behind a disclosure so a long list doesn't push the table away.
export function BulkOutcome({
  summary,
  skipped,
  error,
}: {
  summary: string | null;
  skipped: { label: string; reason: string }[];
  error: string | null;
}) {
  const [open, setOpen] = useState(false);
  if (!summary && !error) return null;
  return (
    <div className="mb-3 text-sm" aria-live="polite">
      {error && <p className="text-overdue">{error}</p>}
      {summary && (
        <p className="text-ink">
          {summary}
          {skipped.length > 0 && (
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              className="ml-2 text-ink-muted underline decoration-dotted underline-offset-2 hover:text-ink"
            >
              {open ? "Hide" : "Why were some skipped?"}
            </button>
          )}
        </p>
      )}
      {open && skipped.length > 0 && (
        <ul className="mt-1 max-h-40 list-disc overflow-y-auto pl-5 text-xs text-ink-muted">
          {skipped.map((s, i) => (
            <li key={i}>
              <span className="text-ink">{s.label}</span> — {s.reason}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export const bulkSelectClass =
  "rounded-md border border-line bg-surface px-2 py-1 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40";
export const bulkButtonClass =
  "rounded-md border border-line bg-surface px-2.5 py-1 text-sm font-medium text-ink hover:bg-black/5 disabled:opacity-50";

// Selection state for a table: a set of ids, pruned to what's on screen so a
// filter change can never leave invisible rows selected.
export function useSelection(visibleIds: string[]) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const visible = new Set(visibleIds);
  const selectedVisible = [...selected].filter((id) => visible.has(id));
  const allSelected = visibleIds.length > 0 && selectedVisible.length === visibleIds.length;
  return {
    selectedIds: selectedVisible,
    isSelected: (id: string) => selected.has(id) && visible.has(id),
    toggle: (id: string) =>
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    allSelected,
    toggleAll: () => setSelected(allSelected ? new Set() : new Set(visibleIds)),
    clear: () => setSelected(new Set()),
  };
}
