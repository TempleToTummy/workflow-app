"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { RecurringType } from "@prisma/client";
import { setAssignmentDueOffset } from "@/lib/actions";
import { describeDueRule, clampOffset, MIN_OFFSET_DAYS, MAX_OFFSET_DAYS } from "@/lib/due-dates";

// The deadline panel on an engagement: what this client's work is due, and the
// override that makes this client different from everyone else on the service
// (an extension on file, a negotiated turnaround).
//
// Clearing the override puts the client back on the service's rule. Either way
// the change recomputes the stored due dates on this engagement's task rows,
// so the dashboard and Tasks list move with it.
export function AssignmentDuePanel({
  clientId,
  projectId,
  recurring,
  projectOffset,
  clientOffset,
  engagementDue,
  periodName,
}: {
  clientId: string;
  projectId: string;
  recurring: RecurringType;
  projectOffset: number;
  clientOffset: number | null;
  engagementDue: string | null; // preformatted — the server already resolved it
  periodName: string | null;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(clientOffset === null ? "" : String(clientOffset));
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const effective = clientOffset ?? projectOffset;

  function save(next: number | null) {
    setError(null);
    startTransition(async () => {
      try {
        await setAssignmentDueOffset(clientId, projectId, next);
        setEditing(false);
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't save the due-date override.");
      }
    });
  }

  function commit() {
    const text = value.trim();
    if (text === "") return save(null);
    const n = Number(text);
    if (!Number.isFinite(n)) {
      setError("Enter a number of days.");
      return;
    }
    save(clampOffset(n));
  }

  return (
    <div className="rounded-lg border border-line bg-surface p-4">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
        Deadline
      </h3>

      <p className="mt-2 text-lg font-semibold text-ink">
        {engagementDue ?? "No due date"}
      </p>
      {periodName && (
        <p className="tabular text-[11px] text-ink-muted">for {periodName}</p>
      )}

      <p className="mt-2 text-xs text-ink-muted">
        {describeDueRule(effective, recurring)}{" "}
        {clientOffset === null ? (
          <span>Following the service&apos;s rule.</span>
        ) : (
          <span className="text-[var(--status-review)]">
            Overridden for this client (service rule is {projectOffset}d).
          </span>
        )}
      </p>

      {editing ? (
        <div className="mt-3 flex flex-col gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] uppercase tracking-wide text-ink-muted">
              Days after period end
            </span>
            <input
              autoFocus
              type="number"
              inputMode="numeric"
              min={MIN_OFFSET_DAYS}
              max={MAX_OFFSET_DAYS}
              value={value}
              placeholder={`${projectOffset} (inherit)`}
              disabled={isPending}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commit();
                } else if (e.key === "Escape") {
                  setEditing(false);
                }
              }}
              className="tabular rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40"
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={commit}
              disabled={isPending}
              className="rounded-full bg-accent px-3 py-1 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {isPending ? "Saving…" : "Save"}
            </button>
            {clientOffset !== null && (
              <button
                type="button"
                onClick={() => {
                  setValue("");
                  save(null);
                }}
                disabled={isPending}
                className="rounded-full border border-line px-3 py-1 text-xs text-ink hover:bg-black/5 disabled:opacity-50"
              >
                Use service rule
              </button>
            )}
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="rounded-full border border-line px-3 py-1 text-xs text-ink-muted hover:bg-black/5"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => {
            setValue(clientOffset === null ? "" : String(clientOffset));
            setEditing(true);
          }}
          className="mt-3 w-full rounded-full border border-line px-3 py-1.5 text-xs font-medium text-ink hover:bg-black/5"
        >
          {clientOffset === null ? "Override for this client" : "Edit override"}
        </button>
      )}

      {error && <p className="mt-2 text-xs text-overdue">{error}</p>}
    </div>
  );
}
