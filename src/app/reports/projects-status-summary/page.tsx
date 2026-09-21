import Link from "next/link";
import { prisma } from "@/lib/prisma";

const RECURRING_LABELS: Record<string, string> = {
  MONTHLY: "Monthly",
  QUARTERLY: "Quarterly",
  ANNUAL: "Every Year",
  ONE_TIME: "One time only",
};

export default async function ProjectsStatusSummaryPage() {
  const [projects, assignments, activities] = await Promise.all([
    prisma.project.findMany({ include: { recurring: true }, orderBy: { name: "asc" } }),
    prisma.projectClientMap.findMany({ where: { active: true } }),
    prisma.clientActivity.findMany(),
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
    <div className="mx-auto w-full max-w-4xl px-6 py-10">
      <Link href="/" className="text-sm text-ink-muted hover:text-accent">
        ← Back to home
      </Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">Projects Status Summary</h1>
      <p className="mt-1 text-sm text-ink-muted">
        One line per service: how many clients are on it, and how far along they are this
        period.
      </p>

      <div className="mt-6 flex flex-col gap-3">
        {rows.map(({ project, clientCount, done, taskCount }) => {
          const pct = taskCount === 0 ? 0 : Math.round((done / taskCount) * 100);
          return (
            <div
              key={project.id}
              className="rounded-lg border border-line bg-surface p-4"
            >
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium text-ink">{project.name}</p>
                  <p className="text-xs text-ink-muted">
                    {RECURRING_LABELS[project.recurring.type] ?? project.recurring.type} ·{" "}
                    {clientCount} client{clientCount === 1 ? "" : "s"} assigned
                  </p>
                </div>
                <p className="tabular text-sm text-ink-muted">
                  {taskCount === 0 ? "No active tasks" : `${done}/${taskCount} tasks done`}
                </p>
              </div>
              {taskCount > 0 && (
                <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-black/5">
                  <div
                    className="h-full rounded-full bg-accent"
                    style={{ width: `${pct}%` }}
                  />
                </div>
              )}
            </div>
          );
        })}
        {rows.length === 0 && (
          <p className="rounded-lg border border-dashed border-line px-4 py-10 text-center text-ink-muted">
            No projects yet.
          </p>
        )}
      </div>
    </div>
  );
}
