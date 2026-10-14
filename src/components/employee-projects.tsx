"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setEmployeeProjects } from "@/lib/actions";

export type EmployeeProjectOption = {
  id: string;
  name: string;
  recurringLabel: string;
  // Who handles it now, when that's somebody other than this employee.
  otherOwner: string | null;
  activeClients: number;
};

// "Projects they handle" on the employee edit page. Ticking a project makes
// this person its owner: every client on it is pre-assigned to them, period
// after period, with no per-task assigning.
export function EmployeeProjects({
  employeeId,
  employeeName,
  projects,
  owned,
}: {
  employeeId: string;
  employeeName: string;
  projects: EmployeeProjectOption[];
  owned: string[];
}) {
  const router = useRouter();
  const [selected, setSelected] = useState(() => new Set(owned));
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const ownedSet = new Set(owned);
  const dirty = selected.size !== ownedSet.size || [...selected].some((id) => !ownedSet.has(id));
  const takingOver = projects.filter((p) => selected.has(p.id) && !ownedSet.has(p.id) && p.otherOwner);

  function toggle(id: string) {
    setMessage(null);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function save() {
    setError(null);
    setMessage(null);
    startTransition(async () => {
      try {
        const r = await setEmployeeProjects(employeeId, [...selected]);
        const parts = ["Saved."];
        if (r.filled > 0) {
          parts.push(`${r.filled} open task${r.filled === 1 ? " that had" : "s that had"} no one assigned now ${r.filled === 1 ? "goes" : "go"} to ${employeeName}.`);
        }
        setMessage(parts.join(" "));
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't save.");
      }
    });
  }

  return (
    <div className="mt-6 rounded-lg border border-line bg-surface p-6">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-muted">Projects they handle</h2>
      <p className="mt-1 text-sm text-ink-muted">
        When one of these projects is assigned to a client, every task is assigned to {employeeName}{" "}
        automatically — and every period after that. A client can still have its own owner on its
        engagement page, and a step can name a specialist (e.g. a reviewer).
      </p>

      <ul className="mt-4 grid gap-1 sm:grid-cols-2">
        {projects.map((p) => (
          <li key={p.id}>
            <label className="flex cursor-pointer items-start gap-2.5 rounded-md px-2 py-1.5 hover:bg-black/[0.02]">
              <input
                type="checkbox"
                checked={selected.has(p.id)}
                onChange={() => toggle(p.id)}
                disabled={isPending}
                className="mt-0.5"
              />
              <span className="min-w-0">
                <span className="block text-sm text-ink">{p.name}</span>
                <span className="block text-xs text-ink-muted">
                  {p.recurringLabel} · {p.activeClients} client{p.activeClients === 1 ? "" : "s"}
                  {p.otherOwner && (
                    <>
                      {" · "}
                      <span className={selected.has(p.id) ? "text-[var(--status-review)]" : ""}>
                        {selected.has(p.id) ? `taking over from ${p.otherOwner}` : `handled by ${p.otherOwner}`}
                      </span>
                    </>
                  )}
                </span>
              </span>
            </label>
          </li>
        ))}
        {projects.length === 0 && <li className="text-sm text-ink-muted">No projects yet.</li>}
      </ul>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={isPending || !dirty}
          className="rounded-full bg-accent px-5 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {isPending ? "Saving…" : "Save projects"}
        </button>
        {takingOver.length > 0 && (
          <span className="text-xs text-ink-muted">
            Each project has one owner, so {takingOver.map((p) => p.otherOwner).filter((v, i, a) => a.indexOf(v) === i).join(" and ")}{" "}
            will stop being the default for {takingOver.length === 1 ? "that project" : "those projects"}. Tasks
            already assigned don&apos;t move.
          </span>
        )}
      </div>
      {message && <p className="mt-2 text-xs text-accent">{message}</p>}
      {error && <p className="mt-2 text-xs text-overdue">{error}</p>}
    </div>
  );
}
