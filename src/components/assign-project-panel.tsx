"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { assignProjectToClient } from "@/lib/actions";

export type AssignableProject = {
  id: string;
  name: string;
  cadence: string;
  stepCount: number;
};

// Lets you put an existing client onto another project without going back
// through the edit form. Opens a searchable picker of every project the client
// isn't on yet; each card adds in one click. Runs the same
// assignProjectToClient action the client form uses, so the current period's
// checklist rows are generated identically.
export function AssignProjectPanel({
  clientId,
  projects,
}: {
  clientId: string;
  projects: AssignableProject[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const q = query.trim().toLowerCase();
  const matches = projects.filter(
    (p) => !q || p.name.toLowerCase().includes(q) || p.cadence.toLowerCase().includes(q)
  );

  function add(project: AssignableProject) {
    if (isPending) return;
    setError(null);
    setPendingId(project.id);
    startTransition(async () => {
      try {
        await assignProjectToClient(clientId, project.id);
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : `Couldn't add ${project.name}.`);
      } finally {
        setPendingId(null);
      }
    });
  }

  return (
    <div className="mt-4 border-t border-line pt-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-ink-muted">
          {projects.length === 0
            ? "This client is on every project."
            : `${projects.length} more ${projects.length === 1 ? "project" : "projects"} available.`}
        </p>
        {projects.length > 0 && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className={`rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors ${
              open
                ? "border border-line text-ink hover:bg-black/5"
                : "bg-accent text-white hover:opacity-90"
            }`}
          >
            {open ? "Close" : "+ Add to project"}
          </button>
        )}
      </div>

      {open && (
        <div className="mt-3 rounded-lg border border-line bg-background/60 p-3">
          <label className="flex items-center gap-2 rounded-md border border-line bg-surface px-3 py-2 focus-within:ring-2 focus-within:ring-accent/40">
            <svg viewBox="0 0 20 20" className="h-4 w-4 shrink-0 text-ink-muted" fill="none" aria-hidden>
              <circle cx="9" cy="9" r="5.5" stroke="currentColor" strokeWidth="1.6" />
              <path d="M13.5 13.5L17 17" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search projects…"
              className="min-w-0 flex-1 bg-transparent text-sm text-ink placeholder:text-ink-muted/70 focus:outline-none"
            />
          </label>

          <ul className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {matches.map((p) => {
              const empty = p.stepCount === 0;
              const busy = pendingId === p.id;
              return (
                <li
                  key={p.id}
                  className={`flex items-center justify-between gap-3 rounded-md border bg-surface px-3 py-2.5 ${
                    empty ? "border-dashed border-line" : "border-line hover:border-ink-muted/40"
                  }`}
                >
                  <div className="min-w-0">
                    <p className={`truncate text-sm font-medium ${empty ? "text-ink-muted" : "text-ink"}`}>
                      {p.name}
                    </p>
                    <p className="text-xs text-ink-muted">
                      {p.cadence}
                      {" · "}
                      {empty ? (
                        <>
                          no tasks yet ·{" "}
                          <Link href={`/projects/${p.id}`} className="text-accent hover:underline">
                            set up
                          </Link>
                        </>
                      ) : (
                        <span className="tabular">
                          {p.stepCount} {p.stepCount === 1 ? "step" : "steps"}
                        </span>
                      )}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => add(p)}
                    disabled={empty || isPending}
                    className="shrink-0 rounded-full border border-accent/40 px-3 py-1 text-xs font-medium text-accent hover:bg-accent-soft disabled:cursor-not-allowed disabled:border-line disabled:text-ink-muted disabled:hover:bg-transparent"
                  >
                    {busy ? "Adding…" : "Add"}
                  </button>
                </li>
              );
            })}
            {matches.length === 0 && (
              <li className="rounded-md border border-dashed border-line px-3 py-6 text-center text-xs text-ink-muted sm:col-span-2">
                No projects match “{query}”.
              </li>
            )}
          </ul>
          {error && <p className="mt-2 text-xs text-overdue">{error}</p>}
        </div>
      )}
    </div>
  );
}
