"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { RecurringType } from "@prisma/client";
import { setAssignmentRecurrenceAnchor, setProjectRecurrenceAnchor } from "@/lib/actions";
import {
  RECURRING_LABELS,
  checkAnchor,
  describeSchedule,
  formatPeriodName,
  nextPeriodName,
  usesAnchor,
} from "@/lib/period-names";
import { SchedulePreview, parseDateInput } from "@/components/recurrence-fields";

// Where a project's periods start, and the per-client override of it.
//
// The start date and the due date are separate on purpose: the due date says
// when a period's work is owed, the start date says when periods begin. Moving
// the due date later never delays the next period.

const inputClass =
  "tabular rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40";

// Project page, admin only: the default every client inherits.
export function ProjectSchedule({
  projectId,
  recurring,
  anchor,
}: {
  projectId: string;
  recurring: RecurringType;
  anchor: string; // yyyy-mm-dd or ""
}) {
  const router = useRouter();
  const [value, setValue] = useState(anchor);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const date = parseDateInput(value);
  const check = checkAnchor(recurring, date);
  const dirty = value !== anchor;

  function save(next: string) {
    setError(null);
    setMessage(null);
    startTransition(async () => {
      try {
        await setProjectRecurrenceAnchor(projectId, next);
        setValue(next);
        setMessage("Saved. Each client's next period follows the new start date.");
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't save the start date.");
      }
    });
  }

  return (
    <div className="rounded-lg border border-line bg-surface p-4 shadow-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-ink">Schedule</h2>
        <span className="text-xs text-ink-muted">{RECURRING_LABELS[recurring]}</span>
      </div>
      {usesAnchor(recurring) ? (
        <>
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1 text-xs text-ink-muted">
              Recurs starting on
              <input
                type="date"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                disabled={isPending}
                className={inputClass}
              />
            </label>
            <button
              type="button"
              onClick={() => save(value)}
              disabled={isPending || !dirty || !check.ok}
              className="rounded-full bg-accent px-4 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {isPending ? "Saving…" : "Save"}
            </button>
            {anchor && (
              <button
                type="button"
                onClick={() => save("")}
                disabled={isPending}
                className="px-2 py-1.5 text-xs text-ink-muted hover:text-ink"
              >
                Use calendar default
              </button>
            )}
          </div>
          <div className="mt-2">
            <SchedulePreview type={recurring} anchor={date} />
          </div>
          <p className="mt-1 text-xs text-ink-muted">
            Applies to every client on this project unless they have their own start date. Periods
            already open keep their dates.
          </p>
        </>
      ) : (
        <p className="mt-2 text-xs text-ink-muted">{describeSchedule(recurring)}</p>
      )}
      {message && <p className="mt-2 text-xs text-accent">{message}</p>}
      {error && <p className="mt-2 text-xs text-overdue">{error}</p>}
    </div>
  );
}

// Assignment page sidebar: this client's start date, with the next period it
// would produce shown before saving.
export function EngagementSchedule({
  clientId,
  projectId,
  instance = 1,
  recurring,
  projectAnchor,
  clientAnchor,
  currentPeriod,
}: {
  clientId: string;
  projectId: string;
  // Which copy of the project for this client (src/lib/engagements.ts).
  instance?: number;
  recurring: RecurringType;
  projectAnchor: string; // yyyy-mm-dd or ""
  clientAnchor: string; // yyyy-mm-dd or ""
  currentPeriod: string | null;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(clientAnchor);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  if (recurring === "ONE_TIME") return null;

  const effective = parseDateInput(editing ? value || projectAnchor : clientAnchor || projectAnchor);
  const check = checkAnchor(recurring, effective);
  const next =
    currentPeriod && check.ok ? nextPeriodName(recurring, currentPeriod, effective) : null;

  function save(nextValue: string) {
    setError(null);
    startTransition(async () => {
      try {
        await setAssignmentRecurrenceAnchor(clientId, projectId, nextValue, instance);
        setEditing(false);
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't save the start date.");
      }
    });
  }

  return (
    <div className="rounded-lg border border-line bg-surface p-4">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Schedule</h3>
      <p className="mt-2 text-sm text-ink">{RECURRING_LABELS[recurring]}</p>
      <p className="mt-1 text-xs text-ink-muted">{describeSchedule(recurring, effective)}</p>
      {next && (
        <p className="mt-2 text-xs text-ink-muted">
          Next period: <span className="tabular text-ink">{formatPeriodName(next)}</span>
        </p>
      )}

      {usesAnchor(recurring) &&
        (editing ? (
          <div className="mt-3 flex flex-col gap-2">
            <input
              type="date"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              disabled={isPending}
              className={inputClass}
            />
            {!check.ok && <p className="text-xs text-overdue">{check.reason}</p>}
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => save(value)}
                disabled={isPending || !check.ok}
                className="rounded-full bg-accent px-3 py-1 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                {isPending ? "Saving…" : "Save"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setEditing(false);
                  setValue(clientAnchor);
                }}
                className="text-xs text-ink-muted hover:text-ink"
              >
                Cancel
              </button>
            </div>
            <p className="text-[11px] text-ink-muted">
              The current period keeps its dates. If the new start date doesn&apos;t line up, the
              next period is shortened once so nothing is skipped or done twice.
            </p>
          </div>
        ) : (
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <span className="text-ink-muted">
              {clientAnchor
                ? "This client has its own start date."
                : projectAnchor
                ? "Uses the project's start date."
                : "Uses the calendar default."}
            </span>
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="font-medium text-accent hover:underline"
            >
              Change start date
            </button>
            {clientAnchor && (
              <button
                type="button"
                onClick={() => save("")}
                disabled={isPending}
                className="text-ink-muted hover:text-ink"
              >
                Reset to project&apos;s
              </button>
            )}
          </div>
        ))}
      {error && <p className="mt-2 text-xs text-overdue">{error}</p>}
    </div>
  );
}
