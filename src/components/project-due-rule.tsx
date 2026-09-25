"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { RecurringType } from "@prisma/client";
import { setProjectDueRule } from "@/lib/actions";
import {
  describeDueRule,
  clampOffset,
  MIN_OFFSET_DAYS,
  MAX_OFFSET_DAYS,
} from "@/lib/due-dates";

// The service's deadline rule, edited in place on the project page.
//
// A due date used to be whatever day the accounting period ended, which made
// every monthly client due on the last of the month — almost never the real
// deadline. This sets "N days after the period ends" once for the service, and
// every client on it inherits it (overridable per client on the engagement).
//
// Saving recomputes the stored due date on every task row this project owns,
// so the dashboard reflects the new rule immediately.

// Common filing deadlines, as offsets from a period end. Typing "20" is fine;
// these just save the arithmetic for the usual cases.
const PRESETS: { label: string; days: number; cadence: RecurringType[] }[] = [
  { label: "Last day of period", days: 0, cadence: ["MONTHLY", "QUARTERLY", "ANNUAL", "ONE_TIME"] },
  { label: "10th of next month", days: 10, cadence: ["MONTHLY"] },
  { label: "15th of next month", days: 15, cadence: ["MONTHLY"] },
  { label: "20th of next month", days: 20, cadence: ["MONTHLY"] },
  { label: "End of next month", days: 31, cadence: ["MONTHLY", "QUARTERLY"] },
  { label: "Jan 31", days: 31, cadence: ["ANNUAL"] },
  { label: "Mar 15", days: 74, cadence: ["ANNUAL"] },
  { label: "Apr 15", days: 105, cadence: ["ANNUAL"] },
  { label: "Sep 15 (extended)", days: 258, cadence: ["ANNUAL"] },
  { label: "Oct 15 (extended)", days: 288, cadence: ["ANNUAL"] },
];

export function ProjectDueRule({
  projectId,
  recurring,
  dueOffsetDays,
}: {
  projectId: string;
  recurring: RecurringType;
  dueOffsetDays: number;
}) {
  const router = useRouter();
  const [value, setValue] = useState(String(dueOffsetDays));
  const [saved, setSaved] = useState(dueOffsetDays);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const parsed = Number(value);
  const valid = value.trim() !== "" && Number.isFinite(parsed);
  const preview = valid ? clampOffset(parsed) : saved;
  const dirty = valid && clampOffset(parsed) !== saved;

  const presets = PRESETS.filter((p) => p.cadence.includes(recurring));

  function save(days: number) {
    setError(null);
    setMessage(null);
    startTransition(async () => {
      try {
        const { updated } = await setProjectDueRule(projectId, days);
        setSaved(days);
        setValue(String(days));
        setMessage(
          updated > 0
            ? `Saved. ${updated} task due date${updated === 1 ? "" : "s"} updated.`
            : "Saved."
        );
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't save the due-date rule.");
      }
    });
  }

  return (
    <div className="rounded-lg border border-line bg-surface shadow-sm">
      <div className="border-b border-line px-4 py-3">
        <h2 className="text-sm font-semibold text-ink">Due date rule</h2>
        <p className="text-xs text-ink-muted">
          When work on this service is actually due, relative to the end of each
          accounting period. Every client on this service inherits it.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3 px-4 py-3">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wide text-ink-muted">
            Days after period end
          </span>
          <input
            type="number"
            inputMode="numeric"
            min={MIN_OFFSET_DAYS}
            max={MAX_OFFSET_DAYS}
            value={value}
            disabled={isPending}
            onChange={(e) => {
              setValue(e.target.value);
              setMessage(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && dirty) {
                e.preventDefault();
                save(clampOffset(parsed));
              }
            }}
            className="tabular w-28 rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40"
          />
        </label>

        <p className="mb-1.5 flex-1 text-sm text-ink-muted">
          {describeDueRule(preview, recurring)}
          {dirty && <span className="ml-1 text-[var(--status-review)]">(unsaved)</span>}
        </p>

        <button
          type="button"
          onClick={() => save(clampOffset(parsed))}
          disabled={isPending || !dirty}
          className="mb-1 shrink-0 whitespace-nowrap rounded-full bg-accent px-4 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-40"
        >
          {isPending ? "Saving…" : "Save rule"}
        </button>
      </div>

      {presets.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-line px-4 py-2.5">
          <span className="mr-1 text-[11px] text-ink-muted">Common:</span>
          {presets.map((p) => (
            <button
              key={p.label}
              type="button"
              disabled={isPending}
              onClick={() => {
                setValue(String(p.days));
                save(p.days);
              }}
              className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors disabled:opacity-50 ${
                saved === p.days
                  ? "border-accent bg-accent-soft text-accent"
                  : "border-line text-ink-muted hover:border-ink-muted/40 hover:text-ink"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      )}

      {(message || error) && (
        <p className={`px-4 pb-3 text-xs ${error ? "text-overdue" : "text-ink-muted"}`}>
          {error ?? message}
        </p>
      )}
    </div>
  );
}
