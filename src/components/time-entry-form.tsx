"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { logManualTime } from "@/lib/time-actions";
import { parseDuration, formatMinutes } from "@/lib/time";

type Option = { id: string; name: string };

const inputClass =
  "rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40 disabled:opacity-50";

// Manual time entry — the other half of a time tracker. A timer covers work
// you knew you were starting; this covers the phone call you took, the
// half-hour before you remembered, and the reconstruction of last Thursday.
//
// The duration field takes what people type rather than forcing a format:
// "90", "1:30", "1.5h" and "1h 30m" all mean ninety minutes (see parseDuration
// in src/lib/time.ts). It's parsed as you type and echoed back — "1h 30m"
// under the box — so a misreading is visible BEFORE it's submitted rather than
// discovered in a rollup a month later.
export function TimeEntryForm({
  // When present, time is booked against this checklist step and the client
  // picker is hidden — the engagement comes from the task.
  activityId,
  clients,
  employees,
  // Admins can log on somebody else's timesheet; employees only see their own.
  canLogForOthers,
  currentEmployeeId,
  compact = false,
}: {
  activityId?: string;
  clients?: Option[];
  employees?: Option[];
  canLogForOthers?: boolean;
  currentEmployeeId: string;
  compact?: boolean;
}) {
  const router = useRouter();
  const [duration, setDuration] = useState("");
  const [clientId, setClientId] = useState("");
  const [employeeId, setEmployeeId] = useState(currentEmployeeId);
  const [date, setDate] = useState(today());
  const [billable, setBillable] = useState(true);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const minutes = parseDuration(duration);
  const valid = minutes !== null && minutes > 0;

  function submit() {
    if (!valid) {
      setError("Enter a duration like 45, 1:30 or 1.5h.");
      return;
    }
    setError(null);
    setSaved(null);
    startTransition(async () => {
      try {
        await logManualTime({
          activityId: activityId ?? null,
          clientId: activityId ? null : clientId || null,
          minutes,
          date,
          billable,
          note: note || null,
          employeeId: canLogForOthers ? employeeId : null,
        });
        setSaved(`Logged ${formatMinutes(minutes)}.`);
        setDuration("");
        setNote("");
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't log that time.");
      }
    });
  }

  return (
    <div className={compact ? "" : "rounded-lg border border-line bg-surface p-4"}>
      {!compact && (
        <h2 className="text-sm font-semibold tracking-wide text-ink-muted uppercase">
          Log time
        </h2>
      )}

      <div className={`${compact ? "" : "mt-3"} flex flex-wrap items-start gap-2`}>
        <div className="flex flex-col">
          <input
            value={duration}
            disabled={isPending}
            onChange={(e) => setDuration(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="45, 1:30, 1.5h"
            aria-label="How long"
            className={`${inputClass} tabular w-32`}
          />
          {/* The parse echoed back, so an ambiguous entry is caught here and
              not in next month's billing. */}
          <span
            className={`mt-0.5 text-[11px] ${
              duration && !valid ? "text-overdue" : "text-ink-muted"
            }`}
          >
            {duration
              ? valid
                ? `= ${formatMinutes(minutes)}`
                : "Can't read that"
              : "How long"}
          </span>
        </div>

        <input
          type="date"
          value={date}
          disabled={isPending}
          max={today()}
          onChange={(e) => setDate(e.target.value)}
          aria-label="Date"
          className={`${inputClass} tabular`}
        />

        {!activityId && clients && clients.length > 0 && (
          <select
            value={clientId}
            disabled={isPending}
            onChange={(e) => setClientId(e.target.value)}
            aria-label="Client"
            className={inputClass}
          >
            {/* Internal time is a real category, and forcing it onto whichever
                client is handy is how a profitability report becomes fiction. */}
            <option value="">Internal (no client)</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        )}

        {canLogForOthers && employees && (
          <select
            value={employeeId}
            disabled={isPending}
            onChange={(e) => setEmployeeId(e.target.value)}
            aria-label="Whose timesheet"
            className={inputClass}
          >
            {employees.map((e) => (
              <option key={e.id} value={e.id}>
                {e.id === currentEmployeeId ? `${e.name} (you)` : e.name}
              </option>
            ))}
          </select>
        )}

        <input
          value={note}
          disabled={isPending}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="What was it? (optional)"
          aria-label="Note"
          className={`${inputClass} min-w-48 flex-1`}
        />

        <label className="flex items-center gap-1.5 py-1.5 text-sm text-ink-muted">
          <input
            type="checkbox"
            checked={billable}
            disabled={isPending}
            onChange={(e) => setBillable(e.target.checked)}
            className="h-4 w-4 accent-[var(--accent)]"
          />
          Billable
        </label>

        <button
          type="button"
          onClick={submit}
          disabled={isPending || !valid}
          className="rounded-full bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {isPending ? "Saving…" : "Log"}
        </button>
      </div>

      {error && <p className="mt-2 text-xs text-overdue">{error}</p>}
      {saved && <p className="mt-2 text-xs text-[var(--status-done)]">{saved}</p>}
    </div>
  );
}

// yyyy-mm-dd in LOCAL time. toISOString() would hand back the previous day for
// anyone west of Greenwich, so an evening entry would file itself as yesterday.
function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}
