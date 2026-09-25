import { prisma } from "@/lib/prisma";
import { currentPeriodNames } from "@/lib/work-summary";
import { deriveAssignmentStatus, progressLabel } from "@/lib/workflow";
import { STATUS_WORDS } from "@/lib/audit";
import { resolveRange, toDecimalHours, realizationPercent, isTimeRange } from "@/lib/time";
import { summarizeWorkload, computeLoad, LOAD_LABELS } from "@/lib/workload";
import { describeRequest } from "@/lib/client-requests";
import type { CsvRow } from "@/lib/csv";

// The data behind every CSV export, one builder per report.
//
// Each builder mirrors the columns of the page it exports, and the KEY here is
// the URL segment: /api/export/<key>. Adding a report means adding one entry.
//
// Why these live in their own module rather than inside each page: a route
// handler can't import a page component, so the alternative was a giant switch
// inside the route, which is the same code in a worse place. The honest
// caveat, worth stating rather than hiding: each builder re-queries rather
// than sharing the page's own query, so a page and its export can drift if
// somebody changes one and not the other. The reports are plain reads of the
// same three tables, and the column headers here name the same fields the page
// renders, which keeps that risk small and visible. Where a page computes
// something non-obvious (a derived assignment status, a progress label), the
// builder calls the SAME helper the page calls — deriveAssignmentStatus and
// progressLabel from src/lib/workflow.ts — rather than reimplementing it,
// because that is where a divergence would actually matter.
//
// Exports flatten. A matrix report becomes one row per cell rather than a grid
// with merged headers, because a spreadsheet's whole advantage is that it can
// pivot, filter and sum a flat table — and a grid pasted into Excel cannot be
// any of those things.

const RECURRING_LABELS: Record<string, string> = {
  MONTHLY: "Monthly",
  QUARTERLY: "Quarterly",
  ANNUAL: "Every Year",
  ONE_TIME: "One time only",
};

export type ExportTable = { headers: string[]; rows: CsvRow[] };

export type ReportExport = {
  // The human name, used for the filename and the download button's title.
  label: string;
  // Admin-only is the default, matching src/app/reports/layout.tsx: every
  // report is a firm-wide view and would leak the rest of the firm's work to
  // an employee scoped to their own clients. The few exports that are safely
  // per-user say so.
  scope: "admin" | "self";
  build: (context: ExportContext) => Promise<ExportTable>;
};

export type ExportContext = {
  employeeId: string;
  isAdmin: boolean;
  // Raw search params from the request, so an export can honour the same
  // filters the page was showing.
  params: URLSearchParams;
};

// --- Shared reads -------------------------------------------------------------

// The current-period activity rows for every active engagement, which four of
// the reports all need. Read once per export rather than per row.
async function currentPeriodIndex() {
  const assignments = await prisma.projectClientMap.findMany({
    where: { active: true, client: { archivedAt: null } },
    include: { client: true },
  });
  const activities = await prisma.clientActivity.findMany({
    // Only current periods are ever looked up below.
    where: { periodName: { in: currentPeriodNames(assignments) }, client: { archivedAt: null } },
    select: {
      clientId: true,
      projectId: true,
      periodName: true,
      status: true,
      taskSeqNo: true,
    },
  });

  const byPair = new Map<string, { status: string; taskSeqNo: number }[]>();
  for (const a of activities) {
    const key = `${a.clientId}__${a.projectId}__${a.periodName}`;
    const list = byPair.get(key);
    if (list) list.push(a);
    else byPair.set(key, [a]);
  }

  const forAssignment = (clientId: string, projectId: string, period: string | null) =>
    period ? (byPair.get(`${clientId}__${projectId}__${period}`) ?? []) : [];

  return { assignments, forAssignment };
}

// --- The reports --------------------------------------------------------------

export const REPORT_EXPORTS: Record<string, ReportExport> = {
  "project-activity-list": {
    label: "Project Activity List",
    scope: "admin",
    async build() {
      // Every task row there is (the whole KTAX history), so plain columns
      // only, with names filled in from the small lookup tables: attaching
      // five related records to each of ~100k rows was most of the time.
      const [rows, clients, projects, steps, employees] = await Promise.all([
        prisma.clientActivity.findMany({
          where: { client: { archivedAt: null } },
          orderBy: [
            { client: { companyName: "asc" } },
            { periodName: "desc" },
            { taskSeqNo: "asc" },
          ],
        }),
        prisma.client.findMany({ select: { id: true, companyName: true } }),
        prisma.project.findMany({ select: { id: true, name: true } }),
        prisma.projectSubTask.findMany({ select: { id: true, name: true } }),
        prisma.employee.findMany({ select: { id: true, firstName: true, lastName: true } }),
      ]);
      const clientName = new Map(clients.map((c) => [c.id, c.companyName]));
      const projectName = new Map(projects.map((p) => [p.id, p.name]));
      const stepName = new Map(steps.map((s) => [s.id, s.name]));
      const personName = new Map(employees.map((e) => [e.id, `${e.firstName} ${e.lastName}`]));

      return {
        headers: [
          "Client",
          "Period",
          "Project",
          "Task",
          "Task Seq No",
          "Status",
          "Due date",
          "Due set by hand",
          "Assignee",
          "Estimate (hours)",
          "Completed on",
          "Completed by",
          "Notes",
        ],
        // The export carries more columns than the page's table. That's
        // deliberate: the screen is for scanning, the file is for
        // reconciling, and the fields a reconciliation needs (who signed
        // off, when, whether the date was overridden) are exactly the ones
        // the page leaves out for space.
        rows: rows.map((a) => [
          clientName.get(a.clientId) ?? "",
          a.periodName,
          projectName.get(a.projectId) ?? "",
          stepName.get(a.subTaskId) ?? "",
          a.taskSeqNo,
          STATUS_WORDS[a.status] ?? a.status,
          a.dueDate,
          a.dueDateOverridden,
          a.assigneeId ? personName.get(a.assigneeId) ?? "" : "",
          a.estimatedMinutes === null ? "" : toDecimalHours(a.estimatedMinutes),
          a.completedAt,
          a.completedById ? personName.get(a.completedById) ?? "" : "",
          a.notes,
        ]),
      };
    },
  },

  "projects-status-summary": {
    label: "Projects Status Summary",
    scope: "admin",
    async build() {
      const [projects, index] = await Promise.all([
        prisma.project.findMany({ include: { recurring: true }, orderBy: { name: "asc" } }),
        currentPeriodIndex(),
      ]);

      return {
        headers: [
          "Project",
          "Cadence",
          "Due offset (days)",
          "Active clients",
          "Tasks this period",
          "Tasks done",
          "Percent done",
        ],
        rows: projects.map((p) => {
          const mine = index.assignments.filter((a) => a.projectId === p.id);
          let taskCount = 0;
          let done = 0;
          for (const a of mine) {
            const rows = index.forAssignment(a.clientId, a.projectId, a.currentPeriod);
            taskCount += rows.length;
            done += rows.filter((r) => r.status === "DONE").length;
          }
          return [
            p.name,
            RECURRING_LABELS[p.recurring.type] ?? p.recurring.type,
            p.dueOffsetDays,
            mine.length,
            taskCount,
            done,
            // Blank, not 0%, when there is nothing to be a percentage of —
            // "0% done" against a service nobody is assigned to reads as a
            // problem rather than an absence.
            taskCount === 0 ? "" : Math.round((done / taskCount) * 100),
          ];
        }),
      };
    },
  },

  "project-activity-status": {
    label: "Project Activity Status",
    scope: "admin",
    async build() {
      const [projects, index, periods] = await Promise.all([
        prisma.project.findMany({ orderBy: { name: "asc" } }),
        currentPeriodIndex(),
        prisma.accountingPeriod.findMany(),
      ]);
      const periodByName = new Map(periods.map((p) => [p.name, p]));

      const rows: CsvRow[] = [];
      for (const project of projects) {
        for (const a of index.assignments.filter((x) => x.projectId === project.id)) {
          const activity = index.forAssignment(a.clientId, a.projectId, a.currentPeriod);
          const status = deriveAssignmentStatus(
            activity.map((r) => ({ status: r.status as never, taskSeqNo: r.taskSeqNo }))
          );
          rows.push([
            project.name,
            a.client.companyName,
            a.currentPeriod,
            STATUS_WORDS[status] ?? status,
            progressLabel(
              activity.map((r) => ({ status: r.status as never, taskSeqNo: r.taskSeqNo }))
            ),
            a.currentPeriod ? (periodByName.get(a.currentPeriod)?.endDate ?? null) : null,
          ]);
        }
      }

      return {
        headers: ["Project", "Client", "Period", "Status", "Progress", "Period ends"],
        rows,
      };
    },
  },

  "client-activity-matrix": {
    label: "Client Activity Matrix",
    scope: "admin",
    async build() {
      const [clients, projects, index] = await Promise.all([
        prisma.client.findMany({ where: { archivedAt: null }, orderBy: { companyName: "asc" } }),
        prisma.project.findMany({ orderBy: { name: "asc" } }),
        currentPeriodIndex(),
      ]);
      const pairs = new Map(
        index.assignments.map((a) => [`${a.clientId}__${a.projectId}`, a])
      );

      // Flattened to one row per client/service pair. A 40-column grid is
      // unreadable in a spreadsheet and impossible to pivot; this shape can be
      // turned back into the on-screen matrix with one pivot table.
      const rows: CsvRow[] = [];
      for (const client of clients) {
        for (const project of projects) {
          const assignment = pairs.get(`${client.id}__${project.id}`);
          if (!assignment) continue;
          const activity = index.forAssignment(client.id, project.id, assignment.currentPeriod);
          const status = deriveAssignmentStatus(
            activity.map((r) => ({ status: r.status as never, taskSeqNo: r.taskSeqNo }))
          );
          rows.push([
            client.companyName,
            project.name,
            assignment.currentPeriod,
            STATUS_WORDS[status] ?? status,
            progressLabel(
              activity.map((r) => ({ status: r.status as never, taskSeqNo: r.taskSeqNo }))
            ),
          ]);
        }
      }

      return {
        headers: ["Client", "Service", "Period", "Status", "Progress"],
        rows,
      };
    },
  },

  "project-summary-matrix": {
    label: "Project Summary Matrix",
    scope: "admin",
    async build() {
      const [projects, index] = await Promise.all([
        prisma.project.findMany({ orderBy: { name: "asc" } }),
        currentPeriodIndex(),
      ]);

      // This one IS a small fixed grid (four status columns), so it keeps its
      // on-screen shape — the flattening argument doesn't apply when the
      // column count can't grow.
      return {
        headers: [
          "Project",
          "Not started",
          "In progress",
          "Awaiting review",
          "Done",
          "Total active clients",
        ],
        rows: projects.map((p) => {
          const counts: Record<string, number> = {
            NOT_STARTED: 0,
            IN_PROGRESS: 0,
            AWAITING_REVIEW: 0,
            DONE: 0,
          };
          const mine = index.assignments.filter((a) => a.projectId === p.id);
          for (const a of mine) {
            const activity = index.forAssignment(a.clientId, a.projectId, a.currentPeriod);
            const status = deriveAssignmentStatus(
              activity.map((r) => ({ status: r.status as never, taskSeqNo: r.taskSeqNo }))
            );
            counts[status] = (counts[status] ?? 0) + 1;
          }
          return [
            p.name,
            counts.NOT_STARTED,
            counts.IN_PROGRESS,
            counts.AWAITING_REVIEW,
            counts.DONE,
            mine.length,
          ];
        }),
      };
    },
  },

  "project-task-compare": {
    label: "Project Task Compare",
    scope: "admin",
    async build() {
      const projects = await prisma.project.findMany({
        include: {
          subtasks: {
            include: {
              subTask: true,
              defaultAssignee: { select: { firstName: true, lastName: true } },
            },
            orderBy: { sequence: "asc" },
          },
        },
        orderBy: { name: "asc" },
      });

      // Flattened, for the same reason as the activity matrix: the on-screen
      // version grows a column per project.
      const rows: CsvRow[] = [];
      for (const p of projects) {
        p.subtasks.forEach((tm, i) => {
          rows.push([
            p.name,
            i + 1,
            tm.sequence,
            tm.subTask.name,
            tm.defaultAssignee
              ? `${tm.defaultAssignee.firstName} ${tm.defaultAssignee.lastName}`
              : "",
            tm.dueOffsetDays === null ? "" : tm.dueOffsetDays,
            tm.estimatedMinutes === null ? "" : toDecimalHours(tm.estimatedMinutes),
          ]);
        });
      }

      return {
        headers: [
          "Project",
          "Position",
          "Sequence",
          "Step",
          "Default assignee",
          "Step due offset (days)",
          "Estimate (hours)",
        ],
        rows,
      };
    },
  },

  "project-assigned-to-client": {
    label: "Project Assigned to Client",
    scope: "admin",
    async build() {
      const assignments = await prisma.projectClientMap.findMany({
        where: { client: { archivedAt: null } },
        include: {
          client: true,
          project: true,
          defaultAssignee: { select: { firstName: true, lastName: true } },
        },
        orderBy: [{ client: { companyName: "asc" } }, { project: { name: "asc" } }],
      });

      return {
        headers: [
          "Client",
          "Project",
          "Active",
          "Current period",
          "Start date",
          "Completed date",
          "Engagement owner",
          "Due offset override (days)",
          "Note",
        ],
        rows: assignments.map((a) => [
          a.client.companyName,
          a.project.name,
          a.active,
          a.currentPeriod,
          a.startDate,
          a.completedDate,
          a.defaultAssignee
            ? `${a.defaultAssignee.firstName} ${a.defaultAssignee.lastName}`
            : "",
          a.dueOffsetDays === null ? "" : a.dueOffsetDays,
          a.note,
        ]),
      };
    },
  },

  "client-information-list": {
    label: "Client Information List",
    scope: "admin",
    async build() {
      const clients = await prisma.client.findMany({
        where: { archivedAt: null },
        include: { corpType: true, businessType: true },
        orderBy: { companyName: "asc" },
      });

      // ssnEncrypted is deliberately absent, as it is from every form in the
      // app: the column has no encryption behind it yet, and an export is the
      // last place a field like that should first appear.
      return {
        headers: [
          "Client",
          "Group",
          "Corp type",
          "Business type",
          "Tax ID",
          "Phone",
          "Fax",
          "Email",
          "Address 1",
          "Address 2",
          "City",
          "State",
          "Zipcode",
          "Registered on",
          "Registered state",
          "Renewal month",
          "Note",
        ],
        rows: clients.map((c) => [
          c.companyName,
          c.groupName,
          c.corpType?.name ?? "",
          c.businessType?.name ?? "",
          c.taxId,
          c.phone,
          c.fax,
          c.email,
          c.address1,
          c.address2,
          c.city,
          c.state,
          c.zipcode,
          c.coRegDate,
          c.coRegState,
          c.renewMonth,
          c.note,
        ]),
      };
    },
  },

  // --- The new views, exported on the same footing ---------------------------

  "time-entries": {
    label: "Time Entries",
    // An employee may export their OWN timesheet — it's their data, and
    // "send me last month's hours" is the first thing anyone asks of a time
    // tracker. The builder scopes to them unless they're an admin.
    scope: "self",
    async build(context) {
      const rangeKey = context.params.get("range");
      const range = resolveRange(isTimeRange(rangeKey) ? rangeKey : "this-month");
      const { listTimeEntries } = await import("@/lib/time-data");

      const entries = await listTimeEntries({
        employeeId: context.isAdmin ? context.params.get("employeeId") : context.employeeId,
        clientId: context.params.get("clientId"),
        range,
      });

      const headers = [
        "Date",
        "Employee",
        "Client",
        "Service",
        "Period",
        "Task",
        "Hours",
        "Minutes",
        "Billable",
        "Source",
        "Note",
      ];
      // The rate and the amount are admin-only columns. A billing rate is
      // commercially sensitive, so an employee's own timesheet export carries
      // hours and no money — the same rule the on-screen rollups follow.
      if (context.isAdmin) headers.push("Rate", "Amount");

      return {
        headers,
        rows: entries.map((e) => {
          const row: CsvRow = [
            e.startedAt,
            `${e.employee.firstName} ${e.employee.lastName}`,
            e.client?.companyName ?? "",
            e.project?.name ?? "",
            e.periodName ?? "",
            e.activity?.subTask.name ?? "",
            toDecimalHours(e.minutes),
            e.minutes,
            e.billable,
            e.source,
            e.note,
          ];
          if (context.isAdmin) {
            row.push(
              e.rateSnapshot ?? "",
              e.rateSnapshot === null
                ? ""
                : e.billable
                  ? Math.round(toDecimalHours(e.minutes) * e.rateSnapshot * 100) / 100
                  : 0
            );
          }
          return row;
        }),
      };
    },
  },

  "time-summary": {
    label: "Time Summary",
    scope: "admin",
    async build(context) {
      const rangeKey = context.params.get("range");
      const key = isTimeRange(rangeKey) ? rangeKey : "this-month";
      const { timeRollups } = await import("@/lib/time-data");
      const data = await timeRollups({ range: key });

      // One file with both rollups, separated by a blank line and a new
      // header. A spreadsheet reads this fine, and it beats making somebody
      // download the same range twice to get both cuts of it.
      const rows: CsvRow[] = [];
      const push = (heading: string, groups: typeof data.byEmployee) => {
        rows.push([heading, "", "", "", "", ""]);
        for (const g of groups) {
          rows.push([
            g.label,
            toDecimalHours(g.rollup.totalMinutes),
            toDecimalHours(g.rollup.billableMinutes),
            toDecimalHours(g.rollup.nonBillableMinutes),
            realizationPercent(g.rollup) ?? "",
            g.rollup.amount ?? "",
          ]);
        }
        rows.push(["", "", "", "", "", ""]);
      };

      push("By employee", data.byEmployee);
      push("By client", data.byClient);
      push("By service", data.byProject);
      rows.push([
        "TOTAL",
        toDecimalHours(data.total.totalMinutes),
        toDecimalHours(data.total.billableMinutes),
        toDecimalHours(data.total.nonBillableMinutes),
        realizationPercent(data.total) ?? "",
        data.total.amount ?? "",
      ]);

      return {
        headers: [
          `Group (${data.range.label})`,
          "Total hours",
          "Billable hours",
          "Non-billable hours",
          "Realization %",
          "Amount",
        ],
        rows,
      };
    },
  },

  workload: {
    label: "Workload",
    scope: "admin",
    async build() {
      const [employees, open] = await Promise.all([
        prisma.employee.findMany({
          orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
        }),
        prisma.clientActivity.findMany({
          where: { status: { not: "DONE" }, assigneeId: { not: null }, client: { archivedAt: null } },
          select: {
            assigneeId: true,
            status: true,
            dueDate: true,
            estimatedMinutes: true,
          },
        }),
      ]);
      const { loggedMinutesByEmployee } = await import("@/lib/time-data");
      const logged = await loggedMinutesByEmployee(resolveRange("this-week"));

      return {
        headers: [
          "Employee",
          "Open tasks",
          "Committed hours",
          "Tasks with an estimate",
          "Tasks without an estimate",
          "Overdue tasks",
          "Due today",
          "Due this week",
          "Due next week",
          "Weekly capacity (hours)",
          "Load %",
          "Load",
          "Hours logged this week",
        ],
        rows: employees.map((e) => {
          const mine = open.filter((a) => a.assigneeId === e.id);
          const summary = summarizeWorkload(mine);
          const load = computeLoad({
            committedMinutes: summary.committedMinutes,
            weeklyCapacityMinutes: e.weeklyCapacityMinutes,
            estimatedCount: summary.estimatedCount,
          });
          return [
            `${e.firstName} ${e.lastName}`,
            summary.openCount,
            toDecimalHours(summary.committedMinutes),
            summary.estimatedCount,
            summary.unestimatedCount,
            summary.overdueCount,
            summary.buckets.today,
            summary.buckets.thisWeek,
            summary.buckets.nextWeek,
            e.weeklyCapacityMinutes === null ? "" : toDecimalHours(e.weeklyCapacityMinutes),
            load.percent ?? "",
            LOAD_LABELS[load.level],
            toDecimalHours(logged.get(e.id) ?? 0),
          ];
        }),
      };
    },
  },

  "client-requests": {
    label: "Client Requests",
    scope: "admin",
    async build() {
      const requests = await prisma.clientRequest.findMany({
        include: {
          client: { select: { companyName: true } },
          project: { select: { name: true } },
          activity: { include: { subTask: { select: { name: true } } } },
          documents: { select: { id: true } },
        },
        orderBy: { createdAt: "desc" },
      });

      // The token hash is never exported. It is the only secret on the row,
      // and a report is the last place it should leave the database.
      return {
        headers: [
          "Client",
          "Service",
          "Period",
          "Step",
          "Kind",
          "What was asked",
          "State",
          "Raised by",
          "Raised on",
          "Expires",
          "Times opened",
          "Last opened",
          "Files received",
          "Responded on",
          "Responded by",
          "Response",
        ],
        rows: requests.map((r) => [
          r.client.companyName,
          r.project.name,
          r.periodName,
          r.activity?.subTask.name ?? "",
          r.kind === "UPLOAD" ? "Document upload" : "Approval",
          r.title,
          describeRequest({
            kind: r.kind,
            status: r.status,
            expiresAt: r.expiresAt,
            approved: r.approved,
            documentCount: r.documents.length,
          }).label,
          r.createdByLabel,
          r.createdAt,
          r.expiresAt,
          r.viewCount,
          r.lastViewedAt,
          r.documents.length,
          r.completedAt,
          r.respondedByName,
          r.responseNote,
        ]),
      };
    },
  },
};

export function isExportKey(key: string): key is keyof typeof REPORT_EXPORTS {
  return Object.prototype.hasOwnProperty.call(REPORT_EXPORTS, key);
}
