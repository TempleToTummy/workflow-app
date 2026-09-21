"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  setEngagementDefaultAssignee,
  applyDefaultAssignees,
} from "@/lib/actions";

type Employee = { id: string; name: string };

// The engagement's default owner, on the assignment page.
//
// This is the thing that stops someone hand-assigning the same people to the
// same steps every month: set it once, and every period generated from here on
// arrives already assigned. Steps that name their own specialist still win —
// see src/lib/default-assignees.ts for why that precedence and not the reverse.
//
// Changing it is deliberately NOT retroactive. "Apply to unassigned steps" is
// the separate, explicit way to push it onto the period already on screen, and
// it only fills blanks — silently reassigning work somebody has already picked
// up would be a nasty surprise.
export function EngagementDefaults({
  clientId,
  projectId,
  periodName,
  employees,
  defaultAssigneeId,
  unassignedCount,
  stepDefaultCount,
}: {
  clientId: string;
  projectId: string;
  periodName: string | null;
  employees: Employee[];
  defaultAssigneeId: string | null;
  unassignedCount: number;
  stepDefaultCount: number;
}) {
  const router = useRouter();
  const [value, setValue] = useState(defaultAssigneeId ?? "");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function save(next: string) {
    const previous = value;
    setValue(next);
    setError(null);
    setMessage(null);
    startTransition(async () => {
      try {
        await setEngagementDefaultAssignee(clientId, projectId, next || null);
        setMessage(
          next
            ? "Saved. New periods will be assigned automatically."
            : "Cleared. New periods will arrive unassigned."
        );
        router.refresh();
      } catch (err) {
        setValue(previous);
        setError(err instanceof Error ? err.message : "Couldn't save the default.");
      }
    });
  }

  function applyNow() {
    if (!periodName) return;
    setError(null);
    setMessage(null);
    startTransition(async () => {
      try {
        const count = await applyDefaultAssignees(clientId, projectId, periodName);
        setMessage(
          count === 0
            ? "No unassigned step had a default to apply."
            : `Assigned ${count} step${count === 1 ? "" : "s"} from defaults.`
        );
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't apply defaults.");
      }
    });
  }

  const hasAnyDefault = Boolean(value) || stepDefaultCount > 0;

  return (
    <div className="rounded-lg border border-line bg-surface p-4">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
        Default owner
      </h3>
      <p className="mt-1 text-[11px] leading-snug text-ink-muted">
        Who new periods are assigned to. Steps with their own named owner keep it.
      </p>

      <select
        value={value}
        disabled={isPending}
        onChange={(e) => save(e.target.value)}
        aria-label="Default assignee for this engagement"
        className="mt-2 w-full rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40 disabled:opacity-50"
      >
        <option value="">No default — leave unassigned</option>
        {employees.map((e) => (
          <option key={e.id} value={e.id}>
            {e.name}
          </option>
        ))}
      </select>

      {stepDefaultCount > 0 && (
        <p className="mt-2 text-[11px] text-ink-muted">
          {stepDefaultCount} step{stepDefaultCount === 1 ? " has" : "s have"} a named
          owner on the project template.
        </p>
      )}

      {hasAnyDefault && unassignedCount > 0 && periodName && (
        <button
          type="button"
          onClick={applyNow}
          disabled={isPending}
          className="mt-3 w-full rounded-full border border-line px-3 py-1.5 text-xs font-medium text-ink hover:bg-black/5 disabled:opacity-50"
        >
          {isPending
            ? "Applying…"
            : `Apply to ${unassignedCount} unassigned step${unassignedCount === 1 ? "" : "s"}`}
        </button>
      )}

      {message && <p className="mt-2 text-[11px] text-ink-muted">{message}</p>}
      {error && <p className="mt-2 text-[11px] text-overdue">{error}</p>}
    </div>
  );
}
