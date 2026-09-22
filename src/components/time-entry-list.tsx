"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { deleteTimeEntry, updateTimeEntry } from "@/lib/time-actions";
import { formatMinutes, parseDuration, formatMoney, billableAmount } from "@/lib/time";
import { formatDate } from "@/lib/dates";

export type TimeRow = {
  id: string;
  startedAt: string;
  employeeName: string;
  clientName: string | null;
  projectName: string | null;
  taskName: string | null;
  minutes: number;
  billable: boolean;
  source: string;
  note: string | null;
  rateSnapshot: number | null;
  // Whether the viewer may correct this row: their own entry, or any entry
  // when they're an admin. Decided on the server; the action re-checks.
  editable: boolean;
  href: string | null;
};

// A timesheet. Rows are correctable in place, because the alternative — delete
// and re-enter — loses the audit trail of what the entry originally said, and
// "I typed 8 instead of 0.8" is the single most common timesheet error.
export function TimeEntryList({
  entries,
  showEmployee = false,
  showMoney = false,
  emptyMessage = "No time logged yet.",
}: {
  entries: TimeRow[];
  showEmployee?: boolean;
  showMoney?: boolean;
  emptyMessage?: string;
}) {
  if (entries.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-line px-4 py-10 text-center text-sm text-ink-muted">
        {emptyMessage}
      </p>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-line bg-surface">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-line bg-black/[0.02] text-xs tracking-wide text-ink-muted uppercase">
            <th className="px-4 py-2.5 font-medium">Date</th>
            {showEmployee && <th className="px-4 py-2.5 font-medium">Who</th>}
            <th className="px-4 py-2.5 font-medium">Work</th>
            <th className="px-4 py-2.5 font-medium">Note</th>
            <th className="px-4 py-2.5 text-right font-medium">Time</th>
            {showMoney && <th className="px-4 py-2.5 text-right font-medium">Amount</th>}
            <th className="no-print px-4 py-2.5" />
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <EntryRow
              key={entry.id}
              entry={entry}
              showEmployee={showEmployee}
              showMoney={showMoney}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EntryRow({
  entry,
  showEmployee,
  showMoney,
}: {
  entry: TimeRow;
  showEmployee: boolean;
  showMoney: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(entry.minutes));
  const [note, setNote] = useState(entry.note ?? "");
  const [billable, setBillable] = useState(entry.billable);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const parsed = parseDuration(draft);

  function save() {
    if (parsed === null || parsed <= 0) {
      setError("Enter a duration like 45, 1:30 or 1.5h.");
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        await updateTimeEntry(entry.id, { minutes: parsed, billable, note: note || null });
        setEditing(false);
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't save that change.");
      }
    });
  }

  function remove() {
    setError(null);
    startTransition(async () => {
      try {
        await deleteTimeEntry(entry.id);
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't delete that entry.");
      }
    });
  }

  const work = [entry.clientName, entry.projectName, entry.taskName].filter(Boolean).join(" · ");
  const amount = billableAmount(entry.minutes, entry.rateSnapshot, entry.billable);

  return (
    <tr className="border-b border-line last:border-0">
      <td className="tabular px-4 py-2.5 whitespace-nowrap text-ink-muted">
        {formatDate(entry.startedAt)}
      </td>
      {showEmployee && <td className="px-4 py-2.5 text-ink-muted">{entry.employeeName}</td>}
      <td className="px-4 py-2.5">
        {entry.href ? (
          <Link href={entry.href} className="text-ink hover:text-accent">
            {work || "Internal time"}
          </Link>
        ) : (
          <span className="text-ink">{work || "Internal time"}</span>
        )}
        <span className="flex items-center gap-1.5">
          {!entry.billable && (
            <span className="rounded-full bg-black/5 px-1.5 py-0.5 text-[10px] text-ink-muted">
              Non-billable
            </span>
          )}
          {/* A manual entry is a human's recollection; a timer's start and end
              are wall-clock facts. Worth telling apart if a bill is queried. */}
          {entry.source === "manual" && (
            <span className="text-[10px] text-ink-muted">entered by hand</span>
          )}
        </span>
      </td>
      <td className="px-4 py-2.5 text-ink-muted">
        {editing ? (
          <input
            value={note}
            disabled={isPending}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Note"
            className="w-full rounded-md border border-line bg-surface px-2 py-1 text-sm focus:ring-2 focus:ring-accent/40 focus:outline-none"
          />
        ) : (
          (entry.note ?? "—")
        )}
        {error && <span className="block text-[11px] text-overdue">{error}</span>}
      </td>
      <td className="tabular px-4 py-2.5 text-right whitespace-nowrap text-ink">
        {editing ? (
          <span className="flex items-center justify-end gap-1.5">
            <label className="flex items-center gap-1 text-[11px] text-ink-muted">
              <input
                type="checkbox"
                checked={billable}
                disabled={isPending}
                onChange={(e) => setBillable(e.target.checked)}
                className="h-3.5 w-3.5 accent-[var(--accent)]"
              />
              Bill
            </label>
            <input
              value={draft}
              autoFocus
              disabled={isPending}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  save();
                } else if (e.key === "Escape") {
                  setEditing(false);
                }
              }}
              className="tabular w-24 rounded-md border border-line bg-surface px-2 py-1 text-right text-sm focus:ring-2 focus:ring-accent/40 focus:outline-none"
            />
          </span>
        ) : (
          formatMinutes(entry.minutes)
        )}
      </td>
      {showMoney && (
        <td className="tabular px-4 py-2.5 text-right whitespace-nowrap text-ink-muted">
          {/* formatMoney renders a null as "—": a rate nobody set is unknown,
              not zero. */}
          {formatMoney(amount)}
        </td>
      )}
      <td className="no-print px-4 py-2.5 text-right whitespace-nowrap">
        {entry.editable && (
          <span className="flex items-center justify-end gap-2 text-xs text-ink-muted">
            {editing ? (
              <>
                <button
                  type="button"
                  onClick={save}
                  disabled={isPending}
                  className="text-accent hover:underline disabled:opacity-50"
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => setEditing(false)}
                  disabled={isPending}
                  className="hover:text-ink"
                >
                  Cancel
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => {
                    setDraft(String(entry.minutes));
                    setNote(entry.note ?? "");
                    setBillable(entry.billable);
                    setEditing(true);
                  }}
                  className="hover:text-accent"
                >
                  Edit
                </button>
                <button
                  type="button"
                  disabled={isPending}
                  onClick={() => {
                    // Two-step: deleting billable time is exactly what gets
                    // questioned later, so it shouldn't be one stray click.
                    if (!confirmDelete) {
                      setConfirmDelete(true);
                      return;
                    }
                    remove();
                  }}
                  onBlur={() => setConfirmDelete(false)}
                  className={confirmDelete ? "font-medium text-overdue" : "hover:text-overdue"}
                >
                  {confirmDelete ? "Sure?" : "Delete"}
                </button>
              </>
            )}
          </span>
        )}
      </td>
    </tr>
  );
}
