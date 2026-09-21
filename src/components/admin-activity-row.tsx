"use client";

import { useState, useTransition } from "react";
import { updateActivityDetails } from "@/lib/actions";
import { StatusSelect } from "@/components/status-select";
import type { ActivityStatus } from "@prisma/client";

type Employee = { id: string; name: string };

export function AdminActivityRow({
  activityId,
  status,
  notes,
  assigneeId,
  employees,
}: {
  activityId: string;
  status: ActivityStatus;
  notes: string | null;
  assigneeId: string | null;
  employees: Employee[];
}) {
  const [noteValue, setNoteValue] = useState(notes ?? "");
  const [assignee, setAssignee] = useState(assigneeId ?? "");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function save(next: { notes?: string; assigneeId?: string }) {
    setError(null);
    startTransition(async () => {
      try {
        await updateActivityDetails(activityId, {
          notes: next.notes ?? noteValue,
          assigneeId: next.assigneeId ?? assignee,
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't save.");
      }
    });
  }

  return (
    <>
      <td className="px-4 py-2">
        <StatusSelect activityId={activityId} status={status} />
      </td>
      <td className="px-4 py-2">
        <select
          value={assignee}
          disabled={isPending}
          onChange={(e) => {
            setAssignee(e.target.value);
            save({ assigneeId: e.target.value });
          }}
          className="rounded-md border border-line bg-surface px-2 py-1 text-sm text-ink disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-accent/40"
        >
          <option value="">Unassigned</option>
          {employees.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
      </td>
      <td className="px-4 py-2">
        <input
          value={noteValue}
          disabled={isPending}
          onChange={(e) => setNoteValue(e.target.value)}
          onBlur={() => save({ notes: noteValue })}
          placeholder="—"
          className="w-full rounded-md border border-line bg-surface px-2 py-1 text-sm text-ink disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-accent/40"
        />
        {error && <p className="mt-1 text-xs text-overdue">{error}</p>}
      </td>
    </>
  );
}
