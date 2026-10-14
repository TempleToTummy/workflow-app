"use client";

import { useState } from "react";
import type { RecurringType } from "@prisma/client";
import {
  RECURRING_LABELS,
  RECURRING_TYPES,
  checkAnchor,
  describeSchedule,
  firstPeriodName,
  formatPeriodName,
  nextPeriodName,
  usesAnchor,
} from "@/lib/period-names";

// "How often" + "starting on" for a project, with a live preview of the next
// few periods so it's obvious what a start date does before anything is saved.
// Plain form fields (name="recurring", name="recurrenceAnchor"), so it drops
// into any <form> that reads FormData.

const inputClass =
  "rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40";

// yyyy-mm-dd from a date input → local midnight, the same way periods are stored.
export function parseDateInput(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

// The next `count` periods of a schedule, starting with the one a new
// engagement would open today.
export function upcomingPeriods(type: RecurringType, anchor: Date | null, count = 3): string[] {
  if (type === "ONE_TIME") return [];
  const out = [firstPeriodName(type, new Date(), anchor)];
  while (out.length < count) {
    const next = nextPeriodName(type, out[out.length - 1], anchor);
    if (!next) break;
    out.push(next);
  }
  return out;
}

export function SchedulePreview({ type, anchor }: { type: RecurringType; anchor: Date | null }) {
  const check = checkAnchor(type, anchor);
  if (!check.ok) return <p className="text-xs text-overdue">{check.reason}</p>;
  const periods = upcomingPeriods(type, anchor);
  return (
    <div className="text-xs text-ink-muted">
      <p>{describeSchedule(type, anchor)}</p>
      {periods.length > 0 && (
        <p className="mt-1">
          Upcoming:{" "}
          {periods.map((p, i) => (
            <span key={p}>
              {i > 0 && " → "}
              <span className="tabular text-ink">{formatPeriodName(p)}</span>
            </span>
          ))}
        </p>
      )}
    </div>
  );
}

export function RecurrenceFields({
  defaultType = "MONTHLY",
  defaultAnchor = "",
  onTypeChange,
  labelClass = "text-xs text-ink-muted",
}: {
  defaultType?: RecurringType;
  defaultAnchor?: string;
  onTypeChange?: (type: RecurringType) => void;
  labelClass?: string;
}) {
  const [type, setType] = useState<RecurringType>(defaultType);
  const [anchor, setAnchor] = useState(defaultAnchor);
  const anchorDate = parseDateInput(anchor);

  return (
    <>
      <label className="flex flex-col gap-1 text-sm">
        <span className={labelClass}>How often it repeats</span>
        <select
          name="recurring"
          value={type}
          onChange={(e) => {
            const next = e.target.value as RecurringType;
            setType(next);
            onTypeChange?.(next);
          }}
          className={inputClass}
        >
          {RECURRING_TYPES.map((t) => (
            <option key={t} value={t}>
              {RECURRING_LABELS[t]}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className={labelClass}>Recurs starting on</span>
        <input
          type="date"
          name="recurrenceAnchor"
          value={usesAnchor(type) ? anchor : ""}
          disabled={!usesAnchor(type)}
          onChange={(e) => setAnchor(e.target.value)}
          className={`tabular ${inputClass} disabled:opacity-50`}
        />
      </label>
      <div className="sm:col-span-2">
        <SchedulePreview type={type} anchor={usesAnchor(type) ? anchorDate : null} />
        {usesAnchor(type) && (
          <p className="mt-1 text-xs text-ink-muted">
            Leave the date blank for the calendar default. Each client can have its own start date on
            their engagement.
          </p>
        )}
      </div>
    </>
  );
}
