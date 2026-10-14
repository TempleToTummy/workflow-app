import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { StatusBadge } from "@/components/status-badge";
import { deriveAssignmentStatus, progressLabel } from "@/lib/workflow";
import { formatDueDate, dueDateUrgency } from "@/lib/dates";
import { requireUser } from "@/lib/auth";
import { canSee, visibleScope } from "@/lib/access";
import { engagementHref, engagementKeyString, engagementLabel } from "@/lib/engagements";
import { ProjectChecklistBuilder } from "@/components/project-checklist-builder";
import { ProjectDueRule } from "@/components/project-due-rule";
import { describeDueRule, describeRecurrenceVsDue, describeStepOffset } from "@/lib/due-dates";
import { ProjectSchedule } from "@/components/schedule-editor";
import { RECURRING_LABELS, describeSchedule, formatPeriodName, isoDate } from "@/lib/period-names";
import { formatMinutes } from "@/lib/time";

export default async function ProjectDetailPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const user = await requireUser();
  const { projectId } = await params;

  // Project-level visibility: anyone on at least one client's copy of this
  // project can open it, and sees those clients (src/lib/access.ts).
  const scope = await visibleScope(user);
  if (scope && !scope.projectIds.has(projectId)) redirect("/projects");

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      recurring: true,
      owner: true,
      subtasks: { include: { subTask: true }, orderBy: { sequence: "asc" } },
    },
  });
  if (!project) notFound();

  const [assignments, activities, periods, employees] = await Promise.all([
    prisma.projectClientMap.findMany({
      where: { projectId, active: true, client: { archivedAt: null } },
      include: { client: true, defaultAssignee: true },
      orderBy: { instance: "asc" },
    }),
    prisma.clientActivity.findMany({
      where: { projectId, client: { archivedAt: null } },
      select: {
        clientId: true,
        instance: true,
        periodName: true,
        status: true,
        taskSeqNo: true,
        subTaskId: true,
        assigneeId: true,
        dueDate: true,
      },
    }),
    prisma.accountingPeriod.findMany(),
    prisma.employee.findMany({
      orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
      select: { id: true, firstName: true, lastName: true },
    }),
  ]);

  const periodByName = new Map(periods.map((p) => [p.name, p]));
  const stepsInUse = new Set(activities.map((a) => a.subTaskId));
  const checklist = project.subtasks.map((tm) => ({
    subTaskId: tm.subTaskId,
    name: tm.subTask.name,
    inUse: stepsInUse.has(tm.subTaskId),
    dueOffsetDays: tm.dueOffsetDays,
    estimatedMinutes: tm.estimatedMinutes,
    defaultAssigneeId: tm.defaultAssigneeId,
  }));

  const rows = assignments
    // Employees only see the client engagements they're on.
    .filter((a) => canSee(scope, a))
    .map((a) => {
      const acts = activities.filter(
        (act) => act.clientId === a.clientId && act.instance === a.instance && act.periodName === a.currentPeriod
      );
      const responsible = a.defaultAssignee ?? project.owner;
      // Next thing owed on this engagement: the earliest open step's deadline,
      // falling back to the period end for pre-due-date rows.
      const openDated = acts.filter((act) => act.status !== "DONE" && act.dueDate);
      const dueDate =
        (openDated.length > 0
          ? openDated.reduce((min, act) => (act.dueDate! < min.dueDate! ? act : min)).dueDate
          : a.currentPeriod
          ? periodByName.get(a.currentPeriod)?.endDate
          : null) ?? null;
      return {
        key: engagementKeyString(a),
        href: engagementHref(a),
        clientId: a.clientId,
        clientName: a.client.companyName,
        // Shown when this client runs the project more than once, or a copy
        // has its own name.
        copyName:
          a.instance > 1 || a.name ? engagementLabel(project.name, a.name, a.instance) : null,
        responsibleName: responsible ? `${responsible.firstName} ${responsible.lastName}` : null,
        period: a.currentPeriod,
        status: deriveAssignmentStatus(acts),
        progress: progressLabel(acts),
        dueDate,
      };
    })
    .sort((a, b) => {
      if (!a.dueDate) return 1;
      if (!b.dueDate) return -1;
      return a.dueDate.getTime() - b.dueDate.getTime();
    });

  return (
    <div className="mx-auto w-full max-w-6xl px-8 py-8">
      <Link href="/projects" className="text-sm text-ink-muted hover:text-accent">
        ← All projects
      </Link>

      <div className="mt-2 mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">{project.name}</h1>
        {project.description && (
          <p className="mt-1 text-sm text-ink">{project.description}</p>
        )}
        <p className="mt-1 text-sm text-ink-muted">
          {RECURRING_LABELS[project.recurring.type]} · {project.subtasks.length} checklist steps · {rows.length} active client
          {rows.length === 1 ? "" : "s"}
        </p>
        <p className="mt-1 text-sm text-ink-muted">
          {describeSchedule(project.recurring.type, project.recurrenceAnchor)}{" "}
          {describeDueRule(project.dueOffsetDays, project.recurring.type)}{" "}
          {describeRecurrenceVsDue(project.dueOffsetDays, project.recurring.type)}
        </p>
      </div>

      {user.role === "ADMIN" ? (
        <>
          <div className="mb-6 grid gap-4 lg:grid-cols-2">
            <ProjectSchedule
              projectId={projectId}
              recurring={project.recurring.type}
              anchor={project.recurrenceAnchor ? isoDate(project.recurrenceAnchor) : ""}
            />
            <ProjectDueRule
              projectId={projectId}
              recurring={project.recurring.type}
              dueOffsetDays={project.dueOffsetDays}
            />
          </div>

          <div className="mb-8">
            <ProjectChecklistBuilder
              projectId={projectId}
              tasks={checklist}
              employees={employees.map((e) => ({
                id: e.id,
                name: `${e.firstName} ${e.lastName}`,
              }))}
            />
          </div>
        </>
      ) : (
        // Employees see the template but can't change it: an edit here changes
        // every client on the service, including ones they don't work with.
        <div className="mb-8 rounded-lg border border-line bg-surface shadow-sm">
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <h2 className="text-sm font-semibold text-ink">Checklist</h2>
            <span className="text-xs text-ink-muted">
              Read-only · an admin maintains service templates
            </span>
          </div>
          <ol className="divide-y divide-line">
            {checklist.map((t, i) => {
              const owner = employees.find((e) => e.id === t.defaultAssigneeId);
              return (
                <li key={t.subTaskId} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm">
                  <span className="tabular w-6 text-ink-muted">{i + 1}.</span>
                  <span className="flex-1 text-ink">{t.name}</span>
                  {t.dueOffsetDays !== null && (
                    <span className="rounded-full bg-black/5 px-2 py-0.5 text-xs text-ink-muted">
                      {describeStepOffset(t.dueOffsetDays)}
                    </span>
                  )}
                  {t.estimatedMinutes !== null && (
                    <span className="rounded-full bg-black/5 px-2 py-0.5 text-xs text-ink-muted">
                      est. {formatMinutes(t.estimatedMinutes)}
                    </span>
                  )}
                  {owner && (
                    <span className="text-xs text-ink-muted">
                      Owner: {owner.firstName} {owner.lastName}
                    </span>
                  )}
                </li>
              );
            })}
            {checklist.length === 0 && (
              <li className="px-4 py-6 text-center text-sm text-ink-muted">No steps yet.</li>
            )}
          </ol>
        </div>
      )}

      <h2 className="mb-3 text-sm font-semibold text-ink">Clients on this project</h2>
      <div className="overflow-x-auto rounded-lg border border-line bg-surface shadow-sm">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-line bg-black/[0.02] text-xs uppercase tracking-wide text-ink-muted">
              <th className="px-4 py-3 font-medium">Client</th>
              <th className="px-4 py-3 font-medium">Assigned to</th>
              <th className="px-4 py-3 font-medium">Period</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Progress</th>
              <th className="px-4 py-3 font-medium">Due</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const urgency = dueDateUrgency(r.dueDate, r.status);
              return (
                <tr
                  key={r.key}
                  className="border-b border-line last:border-0 hover:bg-black/[0.015]"
                >
                  <td className="px-4 py-4 align-middle">
                    <Link href={r.href} className="font-medium text-ink hover:text-accent">
                      {r.clientName}
                    </Link>
                    {r.copyName && <span className="block text-xs text-ink-muted">{r.copyName}</span>}
                  </td>
                  <td className="px-4 py-4 align-middle text-ink-muted">{r.responsibleName ?? "—"}</td>
                  <td className="tabular px-4 py-4 align-middle text-ink-muted">
                    {r.period ? formatPeriodName(r.period) : "—"}
                  </td>
                  <td className="px-4 py-4 align-middle">
                    <StatusBadge status={r.status} />
                  </td>
                  <td className="tabular px-4 py-4 align-middle text-ink-muted">
                    {r.progress}
                  </td>
                  <td
                    className={`tabular px-4 py-4 align-middle ${
                      urgency === "overdue"
                        ? "font-medium text-overdue"
                        : urgency === "soon"
                        ? "font-medium text-[var(--status-review)]"
                        : "text-ink-muted"
                    }`}
                  >
                    {formatDueDate(r.dueDate)}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-ink-muted">
                  No clients are on this project yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
