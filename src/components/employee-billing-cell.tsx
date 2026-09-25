"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setEmployeeBilling } from "@/lib/time-actions";
import { formatMinutes, parseDuration } from "@/lib/time";
import { CAPACITY_PRESETS } from "@/lib/workload";

// Billing rate and weekly capacity, edited inline on Admin → Employees.
//
// Both are admin-only. A rate is commercially sensitive; capacity is a
// management figure somebody could otherwise raise to look less loaded. The
// action re-checks the role — this component only decides what's drawn.
//
// The note about existing time is the important part of this UI: changing a
// rate does NOT restate work already logged, because each TimeEntry stamps the
// rate that applied when it was written (TimeEntry.rateSnapshot). Without
// saying so, the obvious assumption is the opposite, and somebody would raise
// a rate expecting last quarter to be re-priced.
export function EmployeeBillingCell({
  employeeId,
  hourlyRate,
  weeklyCapacityMinutes,
}: {
  employeeId: string;
  hourlyRate: number | null;
  weeklyCapacityMinutes: number | null;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [rate, setRate] = useState(hourlyRate === null ? "" : String(hourlyRate));
  const [capacity, setCapacity] = useState(
    weeklyCapacityMinutes === null ? "" : String(weeklyCapacityMinutes)
  );
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function save() {
    const rateText = rate.trim();
    const parsedRate = rateText === "" ? null : Number(rateText);
    if (parsedRate !== null && (!Number.isFinite(parsedRate) || parsedRate < 0)) {
      setError("Enter a rate like 150.");
      return;
    }

    const capacityText = capacity.trim();
    // Accepts "40h", "2400" or "37.5h" — the same duration grammar as
    // everywhere else, so nobody has to remember that this one field wants
    // minutes.
    const parsedCapacity = capacityText === "" ? null : parseDuration(capacityText);
    if (capacityText !== "" && parsedCapacity === null) {
      setError("Enter a week like 40h.");
      return;
    }

    setError(null);
    startTransition(async () => {
      try {
        await setEmployeeBilling(employeeId, {
          hourlyRate: parsedRate,
          weeklyCapacityMinutes: parsedCapacity,
        });
        setEditing(false);
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't save that.");
      }
    });
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="text-left text-xs text-ink-muted hover:text-accent"
      >
        <span className="tabular block text-ink">
          {hourlyRate === null ? "No rate" : `${hourlyRate}/h`}
        </span>
        <span className="tabular block">
          {weeklyCapacityMinutes === null
            ? "No capacity"
            : `${formatMinutes(weeklyCapacityMinutes)}/week`}
        </span>
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <input
        value={rate}
        autoFocus
        disabled={isPending}
        onChange={(e) => setRate(e.target.value)}
        placeholder="Rate per hour"
        aria-label="Hourly billing rate"
        className="tabular w-32 rounded-md border border-line bg-surface px-2 py-1 text-xs text-ink focus:ring-2 focus:ring-accent/40 focus:outline-none"
      />
      <input
        value={capacity}
        disabled={isPending}
        onChange={(e) => setCapacity(e.target.value)}
        placeholder="40h per week"
        aria-label="Weekly capacity"
        list={`capacity-${employeeId}`}
        className="tabular w-32 rounded-md border border-line bg-surface px-2 py-1 text-xs text-ink focus:ring-2 focus:ring-accent/40 focus:outline-none"
      />
      <datalist id={`capacity-${employeeId}`}>
        {CAPACITY_PRESETS.map((preset) => (
          <option key={preset.minutes} value={String(preset.minutes)}>
            {preset.label}
          </option>
        ))}
      </datalist>

      <div className="flex gap-1.5">
        <button
          type="button"
          onClick={save}
          disabled={isPending}
          className="whitespace-nowrap rounded-full bg-accent px-2.5 py-1 text-[11px] font-medium text-white disabled:opacity-50"
        >
          Save
        </button>
        <button
          type="button"
          onClick={() => {
            setRate(hourlyRate === null ? "" : String(hourlyRate));
            setCapacity(weeklyCapacityMinutes === null ? "" : String(weeklyCapacityMinutes));
            setEditing(false);
          }}
          disabled={isPending}
          className="rounded-full border border-line px-2.5 py-1 text-[11px] font-medium text-ink"
        >
          Cancel
        </button>
      </div>

      <p className="max-w-40 text-[10px] text-ink-muted">
        Time already logged keeps the rate it was logged at.
      </p>
      {error && <p className="text-[11px] text-overdue">{error}</p>}
    </div>
  );
}
