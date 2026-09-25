import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { DeleteButton } from "@/components/delete-button";
import { deleteProject } from "@/lib/actions";
import { describeDueRule } from "@/lib/due-dates";

const RECURRING_LABELS: Record<string, string> = {
  MONTHLY: "Monthly",
  QUARTERLY: "Quarterly",
  ANNUAL: "Every Year",
  ONE_TIME: "One time only",
};

export default async function ProjectsAdminPage() {
  const projects = await prisma.project.findMany({
    include: { recurring: true, subtasks: true, clientAssignments: true },
    orderBy: { name: "asc" },
  });

  return (
    <div className="mx-auto w-full max-w-6xl px-8 py-8">
      <Link href="/" className="text-sm text-ink-muted hover:text-accent">
        ← Back to home
      </Link>
      <div className="mt-2 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
          <p className="mt-1 text-sm text-ink-muted">
            The service catalog. Manage a project&apos;s checklist on the{" "}
            <Link href="/admin/projects-task-map" className="text-accent hover:underline">
              Projects Task Map
            </Link>{" "}
            page.
          </p>
        </div>
        <Link
          href="/admin/projects/new"
          className="whitespace-nowrap rounded-full bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90"
        >
          New Project
        </Link>
      </div>

      <div className="mt-6 overflow-x-auto rounded-lg border border-line bg-surface">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-line bg-black/[0.02] text-xs uppercase tracking-wide text-ink-muted">
              <th className="px-4 py-3 font-medium">Project</th>
              <th className="px-4 py-3 font-medium">Cadence</th>
              <th className="px-4 py-3 font-medium">Due</th>
              <th className="whitespace-nowrap px-4 py-3 text-center font-medium">Steps</th>
              <th className="whitespace-nowrap px-4 py-3 text-center font-medium">Clients</th>
              <th className="px-4 py-3 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {projects.map((p) => (
              <tr key={p.id} className="border-b border-line last:border-0 hover:bg-black/[0.015]">
                <td className="px-4 py-3">
                  <p className="font-medium text-ink">{p.name}</p>
                  {p.description && <p className="text-xs text-ink-muted">{p.description}</p>}
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-ink-muted">
                  {RECURRING_LABELS[p.recurring.type] ?? p.recurring.type}
                </td>
                <td className="px-4 py-3 text-xs text-ink-muted">
                  {describeDueRule(p.dueOffsetDays, p.recurring.type)}
                </td>
                <td className="tabular whitespace-nowrap px-4 py-3 text-center text-ink-muted">
                  {p.subtasks.length === 0 ? (
                    <span className="text-xs font-medium text-overdue">Not configured</span>
                  ) : (
                    p.subtasks.length
                  )}
                </td>
                <td className="tabular px-4 py-3 text-center text-ink-muted">{p.clientAssignments.length}</td>
                <td className="px-4 py-3">
                  <div className="flex items-center justify-end gap-3">
                    <Link
                      href={`/admin/projects/${p.id}/edit`}
                      className="text-xs text-accent hover:underline"
                    >
                      Edit
                    </Link>
                    <DeleteButton
                      onDelete={deleteProject.bind(null, p.id)}
                      confirmMessage={`Delete the "${p.name}" project template?`}
                    />
                  </div>
                </td>
              </tr>
            ))}
            {projects.length === 0 && (
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
