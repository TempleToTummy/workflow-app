import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { StatusBadge } from "@/components/status-badge";
import { AssignmentTabs, type AssignmentTab } from "@/components/assignment-tabs";
import { AssignmentChecklist } from "@/components/assignment-checklist";
import { AssigneePanel } from "@/components/assignee-panel";
import { AssignmentFiles } from "@/components/assignment-files";
import { AssignmentNotes } from "@/components/assignment-notes";
import { AssignmentDuePanel } from "@/components/assignment-due-panel";
import { EngagementDefaults } from "@/components/engagement-defaults";
import { EngagementHistory } from "@/components/engagement-history";
import { ClientRequestPanel } from "@/components/client-request-panel";
import { TimeEntryForm } from "@/components/time-entry-form";
import { TimeEntryList, type TimeRow } from "@/components/time-entry-list";
import { deriveAssignmentStatus, progressLabel } from "@/lib/workflow";
import { formatDueDate, formatDate } from "@/lib/dates";
import { engagementDueDate, effectiveOffset } from "@/lib/due-dates";
import { requireUser, assigneeScope } from "@/lib/auth";
import { commentsForActivities, mentionCandidates } from "@/lib/comment-data";
import {
  listTimeEntries,
  loggedMinutesByActivity,
  runningTimer,
  timeScope,
} from "@/lib/time-data";
import { rollUp, formatMinutes, formatMoney } from "@/lib/time";
import { requestsForEngagement, bestContactFor } from "@/lib/client-request-data";
import { describeRequest, suggestedKindForStep } from "@/lib/client-requests";

function employeeName(e: { firstName: string; lastName: string }): string {
  return `${e.firstName} ${e.lastName}`;
}

// One client's project, for one accounting period. Defaults to the current
// period; `?period=` opens an earlier one (read the checklist, browse its
// files). Files are scoped to the period being viewed — a period that has
// rolled forward starts with an empty Files tab, and the old period keeps its
// own. Notes are the engagement's running log and carry across periods.
export default async function AssignmentDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ clientId: string; projectId: string }>;
  searchParams: Promise<{ tab?: string; period?: string }>;
}) {
  const user = await requireUser();
  const mine = assigneeScope(user);
  const { clientId, projectId } = await params;
  const { tab: tabParam, period: periodParam } = await searchParams;

  // Employees can open an engagement only if some step in it (any period)
  // is assigned to them.
  if (mine) {
    const onIt = await prisma.clientActivity.count({
      where: { clientId, projectId, assigneeId: mine },
    });
    if (onIt === 0) redirect("/");
  }
  const tab: AssignmentTab =
    tabParam === "files" || tabParam === "notes" || tabParam === "time" ? tabParam : "list";

  const assignment = await prisma.projectClientMap.findUnique({
    where: { clientId_projectId: { clientId, projectId } },
    include: { client: true, project: { include: { recurring: true } } },
  });

  if (!assignment) notFound();

  // Every period this engagement has ever had task rows in, newest first.
  const historyRows = await prisma.clientActivity.findMany({
    where: { clientId, projectId },
    select: { periodName: true, status: true },
  });
  const knownPeriods = new Set(historyRows.map((r) => r.periodName));
  if (assignment.currentPeriod) knownPeriods.add(assignment.currentPeriod);

  const periodName = periodParam || assignment.currentPeriod || null;
  if (periodParam && !knownPeriods.has(periodParam)) notFound();
  const isCurrent = periodName === assignment.currentPeriod;

  const [activities, periodRecords, employees, documents, notes, stepDefaultCount] = await Promise.all([
    prisma.clientActivity.findMany({
      where: { clientId, projectId, periodName: periodName ?? undefined },
      include: {
        subTask: true,
        assignee: true,
        completedBy: true,
        subtasks: { orderBy: { sequence: "asc" } },
      },
      orderBy: { taskSeqNo: "asc" },
    }),
    prisma.accountingPeriod.findMany({ where: { name: { in: [...knownPeriods] } } }),
    prisma.employee.findMany({ orderBy: [{ firstName: "asc" }, { lastName: "asc" }] }),
    prisma.document.findMany({
      where: {
        clientId,
        projectId,
        // Legacy uploads with no period recorded stay visible on the current
        // period only, so nothing silently disappears.
        ...(periodName
          ? isCurrent
            ? { OR: [{ periodName }, { periodName: null }] }
            : { periodName }
          : {}),
      },
      include: { uploadedBy: true },
      orderBy: { createdAt: "desc" },
    }),
    prisma.assignmentNote.findMany({
      where: { clientId, projectId },
      include: { author: true },
      orderBy: { createdAt: "desc" },
    }),
    prisma.projectTaskMap.count({
      where: { projectId, defaultAssigneeId: { not: null } },
    }),
  ]);

  // Everything the new panels need, in one round of parallel reads rather
  // than a query per checklist step.
  const activityIds = activities.map((a) => a.id);
  const [
    commentsByActivity,
    loggedByActivity,
    people,
    timer,
    requests,
    contact,
    timeEntries,
  ] = await Promise.all([
    commentsForActivities(activityIds),
    loggedMinutesByActivity(activityIds),
    mentionCandidates(),
    runningTimer(user.id),
    requestsForEngagement({ clientId, projectId, periodName }),
    bestContactFor(clientId),
    listTimeEntries({ clientId, projectId, periodName }),
  ]);

  const scope = timeScope(user);
  const timeRollup = rollUp(
    timeEntries.map((e) => ({
      minutes: e.minutes,
      billable: e.billable,
      rateSnapshot: e.rateSnapshot,
    }))
  );

  const periodByName = new Map(periodRecords.map((p) => [p.name, p]));
  const period = periodName ? (periodByName.get(periodName) ?? null) : null;

  // The engagement's deadline for the period on screen: the period end pushed
  // out by the service's rule, or by this client's override of it. Individual
  // steps can still sit earlier or later via their own milestone offsets.
  const dueOffset = effectiveOffset(assignment.project.dueOffsetDays, assignment.dueOffsetDays);
  const engagementDue = period ? engagementDueDate(period.endDate, dueOffset) : null;

  const history = [...knownPeriods]
    .map((name) => {
      const rows = historyRows.filter((r) => r.periodName === name);
      return {
        name,
        done: rows.length > 0 && rows.every((r) => r.status === "DONE"),
        start: periodByName.get(name)?.startDate.getTime() ?? 0,
      };
    })
    .sort((a, b) => b.start - a.start || b.name.localeCompare(a.name));

  const basePath = `/assignments/${clientId}/${projectId}`;
  const employeeOptions = employees.map((e) => ({ id: e.id, name: employeeName(e) }));

  const overallStatus = deriveAssignmentStatus(activities);
  const progress = progressLabel(activities);
  const completed = activities.length > 0 && overallStatus === "DONE";

  // yyyy-mm-dd in local time — a date input needs that shape, and going
  // through toISOString() here would shift the day west of Greenwich.
  const isoDay = (d: Date | null) =>
    d
      ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
          d.getDate()
        ).padStart(2, "0")}`
      : null;

  const openRequestsByActivity = new Map<string, number>();
  for (const r of requests) {
    if (r.activityId && r.status === "OPEN") {
      openRequestsByActivity.set(r.activityId, (openRequestsByActivity.get(r.activityId) ?? 0) + 1);
    }
  }

  const steps = activities.map((a) => ({
    id: a.id,
    seq: a.taskSeqNo,
    name: a.subTask.name,
    status: a.status,
    assigneeId: a.assigneeId,
    dueDate: isoDay(a.dueDate),
    dueOverridden: a.dueDateOverridden,
    estimatedMinutes: a.estimatedMinutes,
    loggedMinutes: loggedByActivity.get(a.id) ?? 0,
    timerSince: timer?.activityId === a.id ? timer.startedAt.toISOString() : null,
    comments: commentsByActivity.get(a.id) ?? [],
    openRequests: openRequestsByActivity.get(a.id) ?? 0,
    completedBy: a.completedBy ? employeeName(a.completedBy) : null,
    completedAt: a.completedAt ? formatDate(a.completedAt) : null,
    subtasks: a.subtasks.map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.kind,
      done: s.done,
    })),
  }));

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-10">
      <Link href="/" className="text-sm text-ink-muted hover:text-accent">
        ← Back to dashboard
      </Link>

      <div className="mt-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {assignment.project.name}
          </h1>
          <p className="mt-1 text-sm text-ink-muted">
            <Link href={`/clients/${clientId}`} className="hover:text-accent">
              {assignment.client.companyName}
            </Link>
            {periodName && (
              <>
                {" · "}
                <span className="tabular">{periodName}</span>
                {engagementDue && <> (due {formatDueDate(engagementDue)})</>}
              </>
            )}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="tabular text-sm text-ink-muted">{progress} done</span>
          <StatusBadge status={overallStatus} />
        </div>
      </div>

      {history.length > 1 && (
        <div className="mt-4 flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-xs text-ink-muted">Periods</span>
          {history.map((h) => {
            const active = h.name === periodName;
            const current = h.name === assignment.currentPeriod;
            const href = current ? basePath : `${basePath}?period=${encodeURIComponent(h.name)}`;
            return (
              <Link
                key={h.name}
                href={href}
                aria-current={active ? "page" : undefined}
                className={`tabular flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
                  active
                    ? "border-accent bg-accent-soft text-accent"
                    : "border-line text-ink-muted hover:border-ink-muted/40 hover:text-ink"
                }`}
              >
                {h.done && (
                  <svg viewBox="0 0 20 20" className="h-3 w-3" fill="none" aria-hidden>
                    <path d="M4.5 10.5l3.5 3.5 7.5-8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
                {h.name}
                {current && <span className="font-sans not-italic opacity-70">· current</span>}
              </Link>
            );
          })}
        </div>
      )}

      {completed && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-accent/30 bg-accent-soft px-4 py-3 text-sm text-accent">
          <span className="flex items-center gap-2">
            <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" aria-hidden>
              <circle cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="1.6" />
              <path d="M6.8 10.3l2.2 2.2 4.4-4.8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {isCurrent
              ? "This project is complete."
              : `${periodName} is complete. You're viewing its history.`}
          </span>
          {!isCurrent && assignment.currentPeriod && (
            <Link href={basePath} className="font-medium hover:underline">
              Go to the current period ({assignment.currentPeriod}) →
            </Link>
          )}
        </div>
      )}

      <AssignmentTabs
        basePath={basePath}
        active={tab}
        period={isCurrent ? null : periodName}
        counts={{
          files: documents.length,
          notes: notes.length,
          time: timeEntries.length,
        }}
      />

      <div className="mt-6 flex flex-col gap-6 lg:flex-row">
        <div className="min-w-0 flex-1">
          {tab === "list" && (
            <AssignmentChecklist
              steps={steps}
              employees={employeeOptions}
              people={people}
              currentUserId={user.id}
              isAdmin={user.role === "ADMIN"}
              // A timer running on some OTHER task, so each step's button can
              // say that starting here will stop and log that one.
              timerRunningElsewhere={Boolean(
                timer && !activityIds.includes(timer.activityId ?? "")
              )}
            />
          )}
          {tab === "files" && (
            <AssignmentFiles
              clientId={clientId}
              projectId={projectId}
              periodName={periodName}
              employees={employeeOptions}
              documents={documents.map((d) => ({
                id: d.id,
                filename: d.filename,
                size: d.size,
                uploadedByName: d.uploadedBy ? employeeName(d.uploadedBy) : null,
                createdAt: d.createdAt.toISOString(),
              }))}
            />
          )}
          {tab === "time" && (
            <div className="rounded-lg border border-line bg-surface p-6">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-sm font-semibold tracking-wide text-ink-muted uppercase">
                  Time on {periodName ?? "this engagement"}
                </h2>
                <p className="tabular text-sm text-ink">
                  {formatMinutes(timeRollup.totalMinutes)} logged
                  {timeRollup.billableMinutes !== timeRollup.totalMinutes && (
                    <span className="text-ink-muted">
                      {" "}
                      · {formatMinutes(timeRollup.billableMinutes)} billable
                    </span>
                  )}
                  {/* The amount is admin-only: a billing rate is commercially
                      sensitive, and "can see the task" is not "can see what we
                      charge for it". */}
                  {scope.canSeeMoney && timeRollup.amount !== null && (
                    <span className="text-ink-muted"> · {formatMoney(timeRollup.amount)}</span>
                  )}
                </p>
              </div>

              <div className="mt-4">
                <TimeEntryForm currentEmployeeId={user.id} compact />
                <p className="mt-1.5 text-[11px] text-ink-muted">
                  This logs against the engagement. To book time to a particular step,
                  start its timer on the List tab.
                </p>
              </div>

              <div className="mt-5">
                <TimeEntryList
                  entries={timeEntries.map(
                    (e): TimeRow => ({
                      id: e.id,
                      startedAt: e.startedAt.toISOString(),
                      employeeName: `${e.employee.firstName} ${e.employee.lastName}`,
                      clientName: null,
                      projectName: null,
                      taskName: e.activity?.subTask.name ?? null,
                      minutes: e.minutes,
                      billable: e.billable,
                      source: e.source,
                      note: e.note,
                      rateSnapshot: scope.canSeeMoney ? e.rateSnapshot : null,
                      editable: e.employeeId === user.id || user.role === "ADMIN",
                      href: null,
                    })
                  )}
                  showEmployee
                  showMoney={scope.canSeeMoney}
                  emptyMessage="No time logged against this period yet."
                />
              </div>
            </div>
          )}
          {tab === "notes" && (
            <AssignmentNotes
              clientId={clientId}
              projectId={projectId}
              employees={employeeOptions}
              notes={notes.map((n) => ({
                id: n.id,
                body: n.body,
                authorName: n.author ? employeeName(n.author) : null,
                createdAt: n.createdAt.toISOString(),
              }))}
            />
          )}
        </div>

        <aside className="flex w-full shrink-0 flex-col gap-4 lg:w-72">
          <AssignmentDuePanel
            clientId={clientId}
            projectId={projectId}
            recurring={assignment.project.recurring.type}
            projectOffset={assignment.project.dueOffsetDays}
            clientOffset={assignment.dueOffsetDays}
            engagementDue={engagementDue ? formatDueDate(engagementDue) : null}
            periodName={periodName}
          />
          <ClientRequestPanel
            clientId={clientId}
            projectId={projectId}
            periodName={periodName}
            contactEmail={contact?.email ?? null}
            steps={steps.map((s) => ({
              id: s.id,
              name: s.name,
              suggestedKind: suggestedKindForStep(s.name),
            }))}
            requests={requests.map((r) => {
              const state = describeRequest({
                kind: r.kind,
                status: r.status,
                expiresAt: r.expiresAt,
                approved: r.approved,
                documentCount: r.documents.length,
              });
              return {
                id: r.id,
                kind: r.kind,
                title: r.title,
                stepName: r.activity?.subTask.name ?? null,
                stateLabel: state.label,
                stateTone: state.tone,
                expiresAt: r.expiresAt.toISOString(),
                viewCount: r.viewCount,
                lastViewedAt: r.lastViewedAt ? r.lastViewedAt.toISOString() : null,
                documentCount: r.documents.length,
                respondedByName: r.respondedByName,
                responseNote: r.responseNote,
                createdByLabel: r.createdByLabel,
              };
            })}
          />
          <EngagementDefaults
            clientId={clientId}
            projectId={projectId}
            periodName={periodName}
            employees={employeeOptions}
            defaultAssigneeId={assignment.defaultAssigneeId}
            unassignedCount={steps.filter((s) => !s.assigneeId).length}
            stepDefaultCount={stepDefaultCount}
          />
          <AssigneePanel
            clientId={clientId}
            projectId={projectId}
            periodName={periodName}
            employees={employeeOptions}
            steps={steps.map((s) => ({
              id: s.id,
              name: s.name,
              assigneeId: s.assigneeId,
            }))}
          />
          <EngagementHistory
            clientId={clientId}
            projectId={projectId}
            periodName={periodName}
          />
        </aside>
      </div>
    </div>
  );
}
