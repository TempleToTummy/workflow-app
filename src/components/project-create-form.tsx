"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { RecurringType } from "@prisma/client";
import { createOwnProject } from "@/lib/actions";

const RECURRING_OPTIONS: { value: RecurringType; label: string; hint: string }[] = [
  { value: "MONTHLY", label: "Monthly", hint: "Repeats every month" },
  { value: "QUARTERLY", label: "Quarterly", hint: "Repeats every quarter" },
  { value: "ANNUAL", label: "Annual", hint: "Repeats once a year" },
  { value: "ONE_TIME", label: "One time", hint: "Runs once and closes" },
];

const inputClass =
  "rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40";

// Creates a project outside the admin catalog flow and drops the user straight
// onto its detail page, where the checklist builder lives. Any signed-in user
// can do this — that's the point: nobody is stuck with the seeded templates.
export function ProjectCreateForm() {
  const router = useRouter();
  const [recurring, setRecurring] = useState<RecurringType>("MONTHLY");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const form = new FormData(e.currentTarget);
    const name = String(form.get("name") ?? "");
    const description = String(form.get("description") ?? "");

    startTransition(async () => {
      try {
        const created = await createOwnProject({ name, description, recurring });
        router.push(`/projects/${created.id}`);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't create project.");
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-6">
      <div className="rounded-lg border border-line bg-surface p-6">
        <div className="flex flex-col gap-4">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-ink-muted">Project name *</span>
            <input
              name="name"
              required
              autoFocus
              placeholder="e.g. Payroll Setup, Year-End Close"
              className={inputClass}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-ink-muted">Description</span>
            <input
              name="description"
              placeholder="What this project covers (optional)"
              className={inputClass}
            />
          </label>

          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-xs text-ink-muted">How often does it repeat?</legend>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {RECURRING_OPTIONS.map((o) => {
                const selected = o.value === recurring;
                return (
                  <button
                    key={o.value}
                    type="button"
                    onClick={() => setRecurring(o.value)}
                    aria-pressed={selected}
                    className={`flex flex-col items-start rounded-md border px-3 py-2 text-left transition-colors ${
                      selected
                        ? "border-accent bg-accent-soft"
                        : "border-line hover:bg-black/[0.02]"
                    }`}
                  >
                    <span className={`text-sm font-medium ${selected ? "text-accent" : "text-ink"}`}>
                      {o.label}
                    </span>
                    <span className="text-[11px] text-ink-muted">{o.hint}</span>
                  </button>
                );
              })}
            </div>
          </fieldset>
        </div>
      </div>

      <p className="text-xs text-ink-muted">
        Next you&apos;ll add the tasks for this project and drag them into order.
      </p>

      {error && <p className="text-sm text-overdue">{error}</p>}

      <div className="flex gap-3">
        <button
          type="submit"
          disabled={isPending}
          className="whitespace-nowrap rounded-full bg-accent px-5 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {isPending ? "Creating…" : "Create project"}
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
