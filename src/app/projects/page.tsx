import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { requireUser, assigneeScope } from "@/lib/auth";
import { describeDueRule } from "@/lib/due-dates";

const RECURRING_LABELS: Record<string, string> = {
  MONTHLY: "Monthly",
  QUARTERLY: "Quarterly",
  ANNUAL: "Annual",
  ONE_TIME: "One time",
};

export default async function ProjectsPage() {
  const user = await requireUser();
  const mine = assigneeScope(user);
  const [projects, assignments, activities] = await Promise.all([
    prisma.project.findMany({
      // Employees see only projects they have a task on.
      where: mine ? { activities: { some: { assigneeId: mine } } } : undefined,
      include: { recurring: true, subtasks: true },
      orderBy: { name: "asc" },
    }),
    prisma.projectClientMap.findMany({ where: { active: true, client: { archivedAt: null } } }),
    prisma.clientActivity.findMany({
      where: { client: { archivedAt: null } },
      select: { projectId: true, clientId: true, periodName: true, status: true },
    }),
  ]);

  const rows = projects
    .map((p) => {
      const projAssignments = assignments.filter((a) => a.projectId === p.id);
      const current = new Set(
        projAssignments.map((a) => `${a.clientId}:${a.currentPeriod}`)
      );
      const acts = activities.filter(
        (act) =>
          act.projectId === p.id && current.has(`${act.clientId}:${act.periodName}`)
      );
      const done = acts.filter((a) => a.status === "DONE").length;
      return {
        id: p.id,
        name: p.name,
        description: p.description,
        cadence: RECURRING_LABELS[p.recurring.type] ?? p.recurring.type,
        dueRule: describeDueRule(p.dueOffsetDays, p.recurring.type),
        steps: p.subtasks.length,
        clients: projAssignments.length,
        progressPct: acts.length > 0 ? Math.round((done / acts.length) * 100) : 0,
        progress: `${done}/${acts.length}`,
      };
    })
    .sort((a, b) => b.clients - a.clients || a.name.localeCompare(b.name));

  return (
    <div className="mx-auto w-full max-w-6xl px-8 py-8">
      <div className="mb-6 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Every service the firm offers, with live progress across all clients on
            it this period.
          </p>
        </div>
        {user.role === "ADMIN" && (
          <Link
            href="/projects/new"
            className="whitespace-nowrap rounded-full bg-accent px-4 py-2 text-sm font-medium text-white shadow-sm hover:opacity-90"
          >
            + New Project
          </Link>
        )}
      </div>

      <div className="overflow-x-auto rounded-lg border border-line bg-surface shadow-sm">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-line bg-black/[0.02] text-xs uppercase tracking-wide text-ink-muted">
              <th className="px-4 py-3 font-medium">Project</th>
              <th className="px-4 py-3 font-medium">Cadence</th>
              <th className="px-4 py-3 font-medium">Due</th>
              <th className="px-4 py-3 text-center font-medium">Steps</th>
              <th className="px-4 py-3 text-center font-medium">Clients</th>
              <th className="px-4 py-3 font-medium">Progress this period</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.id}
                className="border-b border-line last:border-0 hover:bg-black/[0.015]"
              >
                <td className="px-4 py-4 align-middle">
                  <Link
                    href={`/projects/${r.id}`}
                    className="font-medium text-ink hover:text-accent"
                  >
                    {r.name}
                  </Link>
                  {r.description && (
                    <p className="text-xs text-ink-muted">{r.description}</p>
                  )}
                </td>
                <td className="whitespace-nowrap px-4 py-4 align-middle text-ink-muted">{r.cadence}</td>
                <td className="px-4 py-4 align-middle text-xs text-ink-muted">
                  {r.dueRule}
                </td>
                <td className="whitespace-nowrap px-4 py-4 text-center align-middle text-ink-muted">
                  {r.steps === 0 ? (
                    <Link href={`/projects/${r.id}`} className="text-xs font-medium text-overdue hover:underline">
                      Add tasks
                    </Link>
                  ) : (
                    <span className="tabular">{r.steps}</span>
                  )}
                </td>
                <td className="tabular px-4 py-4 text-center align-middle text-ink-muted">
                  {r.clients}
                </td>
                <td className="px-4 py-4 align-middle">
                  {r.clients === 0 ? (
                    <span className="text-xs text-ink-muted">No active clients</span>
                  ) : (
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 w-28 shrink-0 overflow-hidden rounded-full bg-line">
                        <div
                          className="h-full rounded-full bg-accent"
                          style={{ width: `${r.progressPct}%` }}
                        />
                      </div>
                      <span className="tabular whitespace-nowrap text-[11px] text-ink-muted">
                        {r.progress}
                      </span>
                    </div>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-ink-muted">
                  No projects yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
