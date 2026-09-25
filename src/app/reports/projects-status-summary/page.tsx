import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { ReportHeader } from "@/components/report-header";

const RECURRING_LABELS: Record<string, string> = {
  MONTHLY: "Monthly",
  QUARTERLY: "Quarterly",
  ANNUAL: "Every Year",
  ONE_TIME: "One time only",
};

export default async function ProjectsStatusSummaryPage() {
  const [projects, assignments, activities] = await Promise.all([
    prisma.project.findMany({ include: { recurring: true }, orderBy: { name: "asc" } }),
    prisma.projectClientMap.findMany({ where: { active: true, client: { archivedAt: null } } }),
    prisma.clientActivity.findMany({ where: { client: { archivedAt: null } } }),
  ]);

  const rows = projects.map((p) => {
    const projectAssignments = assignments.filter((a) => a.projectId === p.id);
    let done = 0;
    let taskCount = 0;
    for (const a of projectAssignments) {
      const periodActivities = activities.filter(
        (act) =>
          act.clientId === a.clientId &&
          act.projectId === a.projectId &&
          act.periodName === a.currentPeriod
      );
      taskCount += periodActivities.length;
      done += periodActivities.filter((act) => act.status === "DONE").length;
    }
    return {
      project: p,
      clientCount: projectAssignments.length,
      done,
      taskCount,
    };
  });

  return (
    <div className="mx-auto w-full max-w-6xl px-8 py-8">
      <Link href="/" className="no-print text-sm text-ink-muted hover:text-accent">
        ← Back to home
      </Link>
      <ReportHeader
        title="Projects Status Summary"
        description="One line per service: how many clients are on it, and how far along they are this period."
        reportKey="projects-status-summary"
      />

      {/* One card with a row per service, every row the same height whether
          or not it has work, so the progress bars line up down the page. */}
      <div className="mt-6 overflow-hidden rounded-lg border border-line bg-surface">
        {rows.map(({ project, clientCount, done, taskCount }) => {
          const pct = taskCount === 0 ? 0 : Math.round((done / taskCount) * 100);
          return (
            <div
              key={project.id}
              className="print-block grid grid-cols-[minmax(0,1fr)_minmax(8rem,16rem)_8rem] items-center gap-6 border-b border-line px-4 py-3 last:border-0"
            >
              <div className="min-w-0">
                <p className={`truncate font-medium ${taskCount > 0 ? "text-ink" : "text-ink-muted"}`}>
                  {project.name}
                </p>
                <p className="text-xs text-ink-muted">
                  {RECURRING_LABELS[project.recurring.type] ?? project.recurring.type} ·{" "}
                  {clientCount} client{clientCount === 1 ? "" : "s"} assigned
                </p>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-black/5">
                {taskCount > 0 && (
                  <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
                )}
              </div>
              <p className="tabular text-right text-sm text-ink-muted">
                {taskCount === 0 ? (
                  <span className="text-ink-muted/60">No active tasks</span>
                ) : (
                  <>
                    <span className="font-medium text-ink">
                      {done}/{taskCount}
                    </span>{" "}
                    done · {pct}%
                  </>
                )}
              </p>
            </div>
          );
        })}
        {rows.length === 0 && (
          <p className="px-4 py-10 text-center text-ink-muted">No projects yet.</p>
        )}
      </div>
    </div>
  );
}
