"use client";

export type EmployeeProjectOption = {
  id: string;
  name: string;
  recurringLabel: string;
  // Who handles it now, when that's somebody other than this employee.
  otherOwner: string | null;
  activeClients: number;
};

// "Projects they handle", part of the employee form on both New Employee and
// Edit Employee. Ticking a project makes this person its owner: every client
// on it is assigned to them at the project level, period after period, with no
// per-task assigning. Saved with the rest of the form.
export function EmployeeProjects({
  employeeName,
  projects,
  selected,
  initiallyOwned,
  onToggle,
  disabled,
}: {
  employeeName: string;
  projects: EmployeeProjectOption[];
  selected: Set<string>;
  initiallyOwned: Set<string>;
  onToggle: (id: string) => void;
  disabled: boolean;
}) {
  const takingOver = projects.filter((p) => selected.has(p.id) && !initiallyOwned.has(p.id) && p.otherOwner);
  const previousOwners = [...new Set(takingOver.map((p) => p.otherOwner))];

  return (
    <div className="rounded-lg border border-line bg-surface p-6">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-muted">Projects they handle</h2>
      <p className="mt-1 text-sm text-ink-muted">
        When one of these projects is assigned to a client, it&apos;s assigned to {employeeName}{" "}
        automatically — every task, every period — and they can see all of it. A client can still have
        its own owner for a project on its engagement page.
      </p>

      <ul className="mt-4 grid gap-1 sm:grid-cols-2">
        {projects.map((p) => (
          <li key={p.id}>
            <label className="flex cursor-pointer items-start gap-2.5 rounded-md px-2 py-1.5 hover:bg-black/[0.02]">
              <input
                type="checkbox"
                checked={selected.has(p.id)}
                onChange={() => onToggle(p.id)}
                disabled={disabled}
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

      {takingOver.length > 0 && (
        <p className="mt-3 text-xs text-ink-muted">
          Each project has one owner, so {previousOwners.join(" and ")} will stop being the owner of{" "}
          {takingOver.length === 1 ? "that project" : "those projects"}. Tasks already assigned to someone
          don&apos;t move.
        </p>
      )}
    </div>
  );
}
