"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createProject, updateProject, type ProjectFormInput } from "@/lib/actions";
import { describeDueRule, SUGGESTED_OFFSETS, clampOffset } from "@/lib/due-dates";
import type { RecurringType } from "@prisma/client";

type ExistingProject = {
  id: string;
  name: string;
  description: string | null;
  recurring: RecurringType;
  dueOffsetDays: number;
};

const RECURRING_OPTIONS: { value: RecurringType; label: string }[] = [
  { value: "MONTHLY", label: "Monthly" },
  { value: "QUARTERLY", label: "Quarterly" },
  { value: "ANNUAL", label: "Every Year" },
  { value: "ONE_TIME", label: "One time only" },
];

const inputClass =
  "rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40";

export function ProjectForm({
  mode,
  project,
}: {
  mode: "create" | "edit";
  project?: ExistingProject;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  // The due-date rule preview updates as you change either field, so it's
  // obvious what "20" means before you save.
  const [recurring, setRecurring] = useState<RecurringType>(project?.recurring ?? "MONTHLY");
  const [offset, setOffset] = useState(
    String(project?.dueOffsetDays ?? SUGGESTED_OFFSETS[project?.recurring ?? "MONTHLY"])
  );

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const form = new FormData(e.currentTarget);
    const values: ProjectFormInput = {
      name: String(form.get("name") ?? ""),
      description: String(form.get("description") ?? ""),
      recurring: String(form.get("recurring") ?? "MONTHLY") as RecurringType,
      dueOffsetDays: clampOffset(Number(form.get("dueOffsetDays") ?? 0)),
    };

    startTransition(async () => {
      try {
        if (mode === "create") {
          await createProject(values);
        } else {
          await updateProject(project!.id, values);
        }
        router.push(`/admin/projects`);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't save project.");
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-6">
      <div className="rounded-lg border border-line bg-surface p-6">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm sm:col-span-2">
            <span className="text-xs text-ink-muted">Project Name *</span>
            <input name="name" defaultValue={project?.name} required className={inputClass} />
          </label>
          <label className="flex flex-col gap-1 text-sm sm:col-span-2">
            <span className="text-xs text-ink-muted">Description</span>
            <input
              name="description"
              defaultValue={project?.description ?? ""}
              className={inputClass}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-ink-muted">Recurring Type</span>
            <select
              name="recurring"
              value={recurring}
              onChange={(e) => {
                const next = e.target.value as RecurringType;
                setRecurring(next);
                // Only nudge the offset toward the new cadence's default while
                // creating — editing an existing service must not silently
                // move a deadline someone set deliberately.
                if (mode === "create") setOffset(String(SUGGESTED_OFFSETS[next]));
              }}
              className={inputClass}
            >
              {RECURRING_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-ink-muted">Due — days after period ends</span>
            <input
              name="dueOffsetDays"
              type="number"
              inputMode="numeric"
              value={offset}
              onChange={(e) => setOffset(e.target.value)}
              className={`tabular ${inputClass}`}
            />
          </label>
          <p className="text-xs text-ink-muted sm:col-span-2">
            {describeDueRule(Number(offset) || 0, recurring)} Individual clients can
            override this on their engagement.
          </p>
        </div>
      </div>

      {error && <p className="text-sm text-overdue">{error}</p>}

      <div className="flex gap-3">
        <button
          type="submit"
          disabled={isPending}
          className="whitespace-nowrap rounded-full bg-accent px-5 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {isPending ? "Saving…" : mode === "create" ? "Create Project" : "Save Changes"}
        </button>
        <button
          type="button"
          onClick={() => router.back()}
          className="rounded-full border border-line px-5 py-2 text-sm font-medium text-ink hover:bg-black/5"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
