import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { formatDueDate } from "@/lib/dates";
import { ReportHeader } from "@/components/report-header";

export default async function ProjectAssignedToClientPage() {
  const assignments = await prisma.projectClientMap.findMany({
    include: { client: true, project: true },
    orderBy: [{ client: { companyName: "asc" } }, { project: { name: "asc" } }],
  });

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-10">
      <Link href="/" className="no-print text-sm text-ink-muted hover:text-accent">
        ← Back to home
      </Link>
      <ReportHeader
        title="Project Assigned to Client"
        description="Every service-to-client assignment on file."
        reportKey="project-assigned-to-client"
      />

      <div className="mt-6 overflow-hidden rounded-lg border border-line bg-surface">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-line bg-black/[0.02] text-xs uppercase tracking-wide text-ink-muted">
              <th className="px-4 py-3 font-medium">Client</th>
              <th className="px-4 py-3 font-medium">Project</th>
              <th className="px-4 py-3 font-medium">Active</th>
              <th className="px-4 py-3 font-medium">Current Period</th>
              <th className="px-4 py-3 font-medium">Start Date</th>
              <th className="px-4 py-3 font-medium">Completed Date</th>
            </tr>
          </thead>
          <tbody>
            {assignments.map((a) => (
              <tr
                key={`${a.clientId}-${a.projectId}`}
                className="border-b border-line last:border-0 hover:bg-black/[0.015]"
              >
                <td className="px-4 py-3">
                  <Link
                    href={`/clients/${a.clientId}`}
                    className="font-medium text-ink hover:text-accent"
                  >
                    {a.client.companyName}
                  </Link>
                </td>
                <td className="px-4 py-3 text-ink-muted">{a.project.name}</td>
                <td className="px-4 py-3 text-ink-muted">{a.active ? "Y" : "N"}</td>
                <td className="px-4 py-3 text-ink-muted">{a.currentPeriod ?? "—"}</td>
                <td className="px-4 py-3 text-ink-muted">{formatDueDate(a.startDate)}</td>
                <td className="px-4 py-3 text-ink-muted">{formatDueDate(a.completedDate)}</td>
              </tr>
            ))}
            {assignments.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-ink-muted">
                  No assignments yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
