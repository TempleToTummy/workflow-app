import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { StatusBadge } from "@/components/status-badge";
import { deriveAssignmentStatus } from "@/lib/workflow";
import { ReportHeader } from "@/components/report-header";

export default async function ClientActivityMatrixPage({
  searchParams,
}: {
  searchParams: Promise<{ all?: string }>;
}) {
  const { all } = await searchParams;
  const showAll = all === "1";

  const [clients, projects, assignments, activities] = await Promise.all([
    prisma.client.findMany({ where: { archivedAt: null }, orderBy: { companyName: "asc" } }),
    prisma.project.findMany({ orderBy: { name: "asc" } }),
    prisma.projectClientMap.findMany({ where: { active: true, client: { archivedAt: null } } }),
    prisma.clientActivity.findMany({ where: { client: { archivedAt: null } } }),
  ]);

  const assignmentByPair = new Map(
    assignments.map((a) => [`${a.clientId}__${a.projectId}`, a])
  );

  function statusFor(clientId: string, projectId: string) {
    const assignment = assignmentByPair.get(`${clientId}__${projectId}`);
    if (!assignment) return null;
    const rows = activities.filter(
      (act) =>
        act.clientId === clientId &&
        act.projectId === projectId &&
        act.periodName === assignment.currentPeriod
    );
    return deriveAssignmentStatus(rows);
  }

  // A service no active client is on is a column of dashes: it widens the grid
  // (and pushes the columns that matter off-screen) without telling anyone
  // anything. Those are folded away by default, with a toggle to bring them
  // back. The CSV export already lists only assigned pairs, so this matches it.
  const usedProjectIds = new Set(assignments.map((a) => a.projectId));
  const unusedCount = projects.filter((p) => !usedProjectIds.has(p.id)).length;
  const columns = showAll ? projects : projects.filter((p) => usedProjectIds.has(p.id));

  return (
    <div className="mx-auto w-full max-w-6xl px-8 py-8">
      <Link href="/" className="no-print text-sm text-ink-muted hover:text-accent">
        ← Back to home
      </Link>
      <ReportHeader
        title="Client Activity Matrix"
        description="Every client's current status across every service, at a glance."
        reportKey="client-activity-matrix"
      />

      {unusedCount > 0 && (
        <p className="no-print mt-4 text-xs text-ink-muted">
          {showAll ? (
            <>
              Showing all {projects.length} services.{" "}
              <Link href="/reports/client-activity-matrix" className="font-medium text-accent hover:underline">
                Hide the {unusedCount} with no active clients
              </Link>
            </>
          ) : (
            <>
              {unusedCount} {unusedCount === 1 ? "service has" : "services have"} no active
              clients and {unusedCount === 1 ? "is" : "are"} hidden.{" "}
              <Link
                href="/reports/client-activity-matrix?all=1"
                className="font-medium text-accent hover:underline"
              >
                Show all services
              </Link>
            </>
          )}
        </p>
      )}

      {/* Both scroll axes live inside the card, capped at the viewport height,
          so the horizontal scrollbar is always on screen instead of at the
          bottom of a long table, and the header row stays visible. */}
      <div className="mt-4 max-h-[calc(100vh-13rem)] overflow-auto rounded-lg border border-line bg-surface">
        <table className="w-full border-separate border-spacing-0 text-left text-sm">
          <thead className="sticky top-0 z-[2]">
            <tr className="bg-[#faf7f0] text-[11px] uppercase tracking-wide text-ink-muted">
              <th className="matrix-sticky w-56 min-w-56 border-b border-line px-4 py-3 align-bottom font-medium">
                Client
              </th>
              {columns.map((p) => (
                <th
                  key={p.id}
                  className="min-w-36 border-b border-line px-3 py-3 text-center align-bottom font-medium leading-snug"
                >
                  {p.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {clients.map((c) => (
              <tr key={c.id} className="group">
                <td className="matrix-sticky whitespace-nowrap border-b border-line px-4 py-2.5 group-last:border-b-0">
                  <Link href={`/clients/${c.id}`} className="font-medium text-ink hover:text-accent">
                    {c.companyName}
                  </Link>
                </td>
                {columns.map((p) => {
                  const status = statusFor(c.id, p.id);
                  return (
                    <td
                      key={p.id}
                      className="border-b border-line px-3 py-2.5 text-center group-last:border-b-0 group-hover:bg-black/[0.015]"
                    >
                      {status ? (
                        <Link
                          href={`/assignments/${c.id}/${p.id}`}
                          title="Open checklist"
                          className="inline-block transition-opacity hover:opacity-80"
                        >
                          <StatusBadge status={status} />
                        </Link>
                      ) : (
                        <span className="text-ink-muted/40">—</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
            {clients.length === 0 && (
              <tr>
                <td colSpan={columns.length + 1} className="px-4 py-10 text-center text-ink-muted">
                  No clients yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
