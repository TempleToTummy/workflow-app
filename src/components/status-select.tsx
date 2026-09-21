"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { ActivityStatus } from "@prisma/client";
import { updateActivityStatus } from "@/lib/actions";

const OPTIONS: { value: ActivityStatus; label: string }[] = [
  { value: "NOT_STARTED", label: "Not started" },
  { value: "IN_PROGRESS", label: "In progress" },
  { value: "AWAITING_REVIEW", label: "Awaiting review" },
  { value: "DONE", label: "Done" },
];

export function StatusSelect({
  activityId,
  status,
}: {
  activityId: string;
  status: ActivityStatus;
}) {
  const router = useRouter();
  const [current, setCurrent] = useState(status);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleChange(next: ActivityStatus) {
    setError(null);
    const previous = current;
    setCurrent(next); // optimistic
    startTransition(async () => {
      try {
        await updateActivityStatus(activityId, next);
        router.refresh();
      } catch (err) {
        setCurrent(previous);
        setError(err instanceof Error ? err.message : "Couldn't update status.");
      }
    });
  }

  return (
    <div className="flex flex-col gap-1">
      <select
        value={current}
        disabled={isPending}
        onChange={(e) => handleChange(e.target.value as ActivityStatus)}
        className="rounded-md border border-line bg-surface px-2 py-1 text-sm text-ink disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-accent/40"
      >
        {OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {error && <span className="text-xs text-overdue">{error}</span>}
    </div>
  );
}
