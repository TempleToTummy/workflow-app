"use client";

import { useState, useTransition } from "react";
import type { RecurringType } from "@prisma/client";
import { createAccountingPeriod } from "@/lib/actions";
import { RECURRING_LABELS, RECURRING_TYPES } from "@/lib/period-names";

const RECURRING_OPTIONS = RECURRING_TYPES.map((value) => ({ value, label: RECURRING_LABELS[value] }));

const inputClass =
  "rounded-md border border-line bg-surface px-3 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40";

export function AccountingPeriodForm() {
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const form = new FormData(e.currentTarget);
    const values = {
      name: String(form.get("name") ?? ""),
      recurring: String(form.get("recurring") ?? "MONTHLY") as RecurringType,
      startDate: String(form.get("startDate") ?? ""),
      endDate: String(form.get("endDate") ?? ""),
    };
    startTransition(async () => {
      try {
        await createAccountingPeriod(values);
        e.currentTarget.reset();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't create period.");
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-3">
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-xs text-ink-muted">Period Name</span>
        <input name="name" required placeholder="e.g. 2026-09" className={inputClass} />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-xs text-ink-muted">Cadence</span>
        <select name="recurring" defaultValue="MONTHLY" className={inputClass}>
          {RECURRING_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-xs text-ink-muted">Start Date</span>
        <input name="startDate" type="date" required className={inputClass} />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-xs text-ink-muted">End Date</span>
        <input name="endDate" type="date" required className={inputClass} />
      </label>
      <button
        type="submit"
        disabled={isPending}
        className="whitespace-nowrap rounded-full bg-accent px-4 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
      >
        Add Period
      </button>
      {error && <p className="w-full text-xs text-overdue">{error}</p>}
    </form>
  );
}
