import { PrismaClient, RecurringType, ActivityStatus } from "@prisma/client";
import { hashPassword, newToken, inviteExpiry } from "../src/lib/password";
import { BUILT_IN_TEMPLATES } from "./email-templates";

const prisma = new PrismaClient();

// Dev-only. Documented in README. Change here (and re-seed) to rotate it.
const ADMIN_EMAIL = "admin@workflow.test";
const ADMIN_PASSWORD = "admin1234";


// Deadline rules, as days after the accounting period's end date (see
// Project.dueOffsetDays and src/lib/due-dates.ts). Only federal statutory
// deadlines are filled in here — those are facts, not guesses. Everything else
// is left at 0 (due the last day of the period) for the firm to set on the
// project page, exactly like the four services whose checklists were never
// confirmed: inventing a client's deadline would be worse than leaving it
// visibly unset.
//
// The annual figures are offsets from a Dec 31 year end:
//   Jan 31 = 31, Mar 15 = 74, Apr 15 = 105.
const DUE_RULES: Record<string, number> = {
  "1099 Form": 31, // federal: recipient + IRS copies due Jan 31
  "Business Tax Return": 74, // federal: calendar-year 1065 / 1120-S due Mar 15
  "Individual Tax Return": 105, // federal: 1040 due Apr 15
  "Tax Return Extension": 105, // an extension has to be filed by the original Apr 15 date
};

function monthPeriodName(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function monthRange(date: Date): { start: Date; end: Date } {
  const start = new Date(date.getFullYear(), date.getMonth(), 1);
  const end = new Date(date.getFullYear(), date.getMonth() + 1, 0);
  return { start, end };
}

// The full service catalog, pulled from the live KTAX app's Project pages
// (name, description, and recurring type match exactly; checklist steps and
// sequence numbers match the ordered task lists shown there). Four services
// (Monthly Financial Report, New Business Registration, Payroll, Quarterly
// Financial Report) had no checklist rows visible in the source app, so they
// exist here as templates with zero steps until real steps are confirmed.
const PROJECT_CATALOG: {
  name: string;
  description: string;
  recurring: RecurringType;
  steps: { seq: number; name: string }[];
}[] = [
  {
    name: "1099 Form",
    description: "1099 Contractor Form",
    recurring: "ANNUAL",
    steps: [
      { seq: 10, name: "Send QuickBooks Contractor report to Client" },
      { seq: 20, name: "Confirm Contractor names and amounts" },
      { seq: 30, name: "Prepare 1099 Forms" },
      { seq: 40, name: "Send 1099 draft to client for review" },
      { seq: 50, name: "Submit / e-file 1099" },
      { seq: 60, name: "Check e-file Acceptance" },
      { seq: 70, name: "Completed Y/N" },
    ],
  },
  {
    name: "Annual Report",
    description: "Annual Report",
    recurring: "ANNUAL",
    steps: [
      { seq: 10, name: "Check client credit card on file" },
      { seq: 20, name: "Send email to client for credit card" },
      { seq: 30, name: "File Annual Report to SOS" },
      { seq: 40, name: "Send new report to client" },
      { seq: 50, name: "Completed Y/N" },
    ],
  },
  {
    name: "Bookkeeping",
    description: "For Bookkeeping",
    recurring: "MONTHLY",
    steps: [
      { seq: 10, name: "Document Received" },
      { seq: 20, name: "Data entry" },
      { seq: 30, name: "Bank Reconciliation" },
      { seq: 40, name: "Reviewer Layer 1" },
      { seq: 42, name: "Ask My accountant query" },
      { seq: 50, name: "Reviewer Layer 2" },
      { seq: 60, name: "Report Sent to Client" },
      { seq: 70, name: "Review done by Client" },
      { seq: 80, name: "Completed Y/N" },
    ],
  },
  {
    name: "Business Tax Return",
    description: "Business Tax Return",
    recurring: "ANNUAL",
    steps: [
      { seq: 10, name: "Review financial with client and gather all end of year documents" },
      { seq: 20, name: "Enter data in tax return, P&L and Balance sheet" },
      { seq: 30, name: "Review K1, basis of each K1, Schedule L, M" },
      { seq: 40, name: "Review state Return" },
      { seq: 45, name: "Master Review" },
      { seq: 50, name: "Review client bank information" },
      { seq: 60, name: "Send return draft copy to client for review" },
      { seq: 70, name: "Send form 8879 for signature" },
      { seq: 80, name: "Send engagement letter for new and one time clients" },
      { seq: 90, name: "Confirm 8879 signed" },
      { seq: 100, name: "Ready to file tax return" },
      { seq: 110, name: "Confirm federal and state both tax return filed" },
      { seq: 120, name: "Confirm federal and state both tax return accepted" },
    ],
  },
  {
    name: "Individual Tax Return",
    description: "Individual Tax Return",
    recurring: "ANNUAL",
    steps: [
      { seq: 10, name: "Received all documents from client" },
      { seq: 20, name: "Enter data and confirm all documents" },
      { seq: 30, name: "Request for any missing documents" },
      { seq: 40, name: "Review with client confirm address and bank info" },
      { seq: 45, name: "Send Draft copy to Client" },
      { seq: 50, name: "Payment Received" },
      { seq: 60, name: "Send form 8879 for signature and return" },
      { seq: 70, name: "Send engagement letter" },
      { seq: 80, name: "Confirm 8879 signed" },
      { seq: 90, name: "Ready to file tax return" },
      { seq: 100, name: "Confirm federal and state both tax return filed" },
      { seq: 110, name: "Confirm federal and state both tax return accepted" },
      { seq: 120, name: "Completed Y/N" },
    ],
  },
  {
    name: "Liquor License Renewal",
    description: "Liquor License Renewal",
    recurring: "ANNUAL",
    steps: [
      { seq: 10, name: "Email reminder to client" },
      { seq: 20, name: "City liquor license" },
      { seq: 30, name: "Insurance Copy" },
      { seq: 40, name: "File liquor license" },
      { seq: 50, name: "Email license copy to Client" },
      { seq: 60, name: "Completed Y/N" },
    ],
  },
  {
    name: "Monthly Financial Report",
    description: "Monthly Financial Report Need to send every month",
    recurring: "MONTHLY",
    steps: [],
  },
  {
    name: "New Business Registration",
    description: "New Business Registration.",
    recurring: "ONE_TIME",
    steps: [],
  },
  {
    name: "Payroll",
    description: "Payroll",
    recurring: "MONTHLY",
    steps: [],
  },
  {
    name: "Quarterly Financial Report",
    description: "Quarterly Financial Report Need to send every Quarter",
    recurring: "QUARTERLY",
    steps: [],
  },
  {
    name: "Sales Tax",
    description: "Sales Tax",
    recurring: "MONTHLY",
    steps: [
      { seq: 10, name: "Document Received" },
      { seq: 20, name: "Verify report" },
      { seq: 30, name: "Start calculation and verify" },
      { seq: 40, name: "Start return and verify" },
      { seq: 50, name: "Submit return" },
      { seq: 60, name: "Verify bank and submit payment" },
      { seq: 70, name: "Save return and payment confirmation" },
      { seq: 80, name: "Send Sales return to client" },
      { seq: 90, name: "Record sales journal in QB" },
      { seq: 100, name: "Completed Y/N" },
    ],
  },
  {
    name: "Tax Return Extension",
    description: "Individual and Business Tax Return Extension",
    recurring: "ANNUAL",
    steps: [
      { seq: 10, name: "Create Extension" },
      { seq: 20, name: "Submit Extension" },
      { seq: 30, name: "Accepted Extension" },
      { seq: 40, name: "Completed Y/N" },
    ],
  },
  {
    name: "Tobacco License Renewal",
    description: "Tobacco License Renewal",
    recurring: "ANNUAL",
    steps: [
      { seq: 10, name: "Email reminder to client" },
      { seq: 20, name: "Submit payment" },
      { seq: 30, name: "Email license copy to Client" },
      { seq: 40, name: "Completed Y/N" },
    ],
  },
];

async function main() {
  console.log("Seeding database...");

  await prisma.emailMessage.deleteMany();
  await prisma.emailTemplate.deleteMany();
  await prisma.assignmentNote.deleteMany();
  await prisma.document.deleteMany();
  await prisma.activitySubtask.deleteMany();
  await prisma.clientActivity.deleteMany();
  await prisma.projectClientMap.deleteMany();
  await prisma.projectTaskMap.deleteMany();
  await prisma.projectSubTask.deleteMany();
  await prisma.project.deleteMany();
  await prisma.accountingPeriod.deleteMany();
  await prisma.projectRecurring.deleteMany();
  await prisma.corpContact.deleteMany();
  await prisma.client.deleteMany();
  await prisma.corporationType.deleteMany();
  await prisma.businessType.deleteMany();
  await prisma.session.deleteMany();
  await prisma.employee.deleteMany();
  await prisma.employeeType.deleteMany();

  // --- Lookups -------------------------------------------------------
  const corpTypes = await Promise.all(
    ["LLC", "S-Corp", "C-Corp", "Sole Proprietor"].map((name) =>
      prisma.corporationType.create({ data: { name } })
    )
  );

  const businessTypes = await Promise.all(
    ["Retail", "Professional Services", "Food & Beverage", "Fitness"].map((name) =>
      prisma.businessType.create({ data: { name } })
    )
  );

  const employeeType = await prisma.employeeType.create({
    data: { name: "Staff Accountant" },
  });

  // The one account that can log in out of the box. Everyone else is
  // invite-pending until the admin sends them their /invite/<token> link.
  await prisma.employee.create({
    data: {
      firstName: "Site",
      lastName: "Admin",
      email: ADMIN_EMAIL,
      role: "ADMIN",
      passwordHash: await hashPassword(ADMIN_PASSWORD),
      employeeTypeId: employeeType.id,
    },
  });

  const staff = await Promise.all(
    [
      { firstName: "Priya", lastName: "Nair", email: "priya@firm.test" },
      { firstName: "Marcus", lastName: "Webb", email: "marcus@firm.test" },
      { firstName: "Dana", lastName: "Ruiz", email: "dana@firm.test" },
    ].map((e) =>
      prisma.employee.create({
        data: {
          ...e,
          role: "EMPLOYEE",
          passwordHash: null,
          inviteToken: newToken(),
          inviteTokenExpiresAt: inviteExpiry(),
          employeeTypeId: employeeType.id,
        },
      })
    )
  );

  // --- Recurrence types + accounting periods ---------------------------
  const recurringByType = Object.fromEntries(
    await Promise.all(
      (["MONTHLY", "QUARTERLY", "ANNUAL", "ONE_TIME"] as RecurringType[]).map(
        async (type) => [type, await prisma.projectRecurring.create({ data: { type } })]
      )
    )
  ) as Record<RecurringType, { id: string; type: RecurringType }>;

  // Monthly periods: 2 back, current, 1 ahead
  const today = new Date();
  const monthlyPeriods = [];
  for (let offset = -2; offset <= 1; offset++) {
    const d = new Date(today.getFullYear(), today.getMonth() + offset, 1);
    const { start, end } = monthRange(d);
    const period = await prisma.accountingPeriod.create({
      data: {
        name: monthPeriodName(d),
        startDate: start,
        endDate: end,
        recurringId: recurringByType.MONTHLY.id,
      },
    });
    monthlyPeriods.push(period);
  }
  const currentMonthlyPeriod = monthlyPeriods[2]; // offset 0

  // --- Project templates + ordered subtasks, from the real service catalog
  const projectsByName: Record<string, { id: string; name: string }> = {};
  const subtasksByProject: Record<string, { id: string; name: string }[]> = {};

  for (const def of PROJECT_CATALOG) {
    const project = await prisma.project.create({
      data: {
        name: def.name,
        description: def.description,
        recurringId: recurringByType[def.recurring].id,
        dueOffsetDays: DUE_RULES[def.name] ?? 0,
      },
    });
    projectsByName[def.name] = project;

    const subtasks = [];
    for (const step of def.steps) {
      const subtask = await prisma.projectSubTask.create({ data: { name: step.name } });
      await prisma.projectTaskMap.create({
        data: { projectId: project.id, subTaskId: subtask.id, sequence: step.seq },
      });
      subtasks.push(subtask);
    }
    subtasksByProject[def.name] = subtasks;
  }

  // The firm's reusable client messages, keyed to the checklist steps that
  // actually require writing to a client. See prisma/email-templates.ts.
  for (const template of BUILT_IN_TEMPLATES) {
    await prisma.emailTemplate.create({ data: { ...template, builtIn: true } });
  }

  const bookkeeping = projectsByName["Bookkeeping"];
  const bookkeepingSubtasks = subtasksByProject["Bookkeeping"];
  const salesTax = projectsByName["Sales Tax"];
  const salesTaxSubtasks = subtasksByProject["Sales Tax"];

  // --- Clients ---------------------------------------------------------
  const clientDefs = [
    { companyName: "Bluepoint Bakery", email: "hello@bluepointbakery.test", businessType: "Food & Beverage" },
    { companyName: "Ridgeline Landscaping", email: "billing@ridgelinelandscape.test", businessType: "Professional Services" },
    { companyName: "Nova Fitness Studio", email: "admin@novafitness.test", businessType: "Fitness" },
    { companyName: "Maple & Co. Cafe", email: "owner@mapleandco.test", businessType: "Food & Beverage" },
  ];

  const clients = [];
  for (const [i, c] of clientDefs.entries()) {
    const client = await prisma.client.create({
      data: {
        companyName: c.companyName,
        email: c.email,
        corpTypeId: corpTypes[i % corpTypes.length].id,
        businessTypeId: businessTypes.find((b) => b.name === c.businessType)?.id,
      },
    });
    clients.push(client);
  }

  // --- Assign a couple of services to each sample client, generate this
  // period's activity rows (same job the source app's insert trigger did).
  let createdActivities = 0;
  for (const [i, client] of clients.entries()) {
    await prisma.projectClientMap.create({
      data: {
        clientId: client.id,
        projectId: bookkeeping.id,
        active: true,
        createSubtask: true,
        currentPeriod: currentMonthlyPeriod.name,
      },
    });

    // Sequential-ish statuses: earlier steps more likely done than later ones,
    // matching the "can't finish step 3 before step 1" rule from the source app.
    for (const [seq, subtask] of bookkeepingSubtasks.entries()) {
      const progressCutoff = (i % bookkeepingSubtasks.length) + 1;
      const status: ActivityStatus =
        seq < progressCutoff - 1
          ? ActivityStatus.DONE
          : seq === progressCutoff - 1
          ? ActivityStatus.IN_PROGRESS
          : ActivityStatus.NOT_STARTED;

      await prisma.clientActivity.create({
        data: {
          clientId: client.id,
          projectId: bookkeeping.id,
          subTaskId: subtask.id,
          periodName: currentMonthlyPeriod.name,
          taskSeqNo: seq + 1,
          status,
          assigneeId: staff[i % staff.length].id,
        },
      });
      createdActivities++;
    }

    // Only half the clients also get sales tax filing this month
    if (i % 2 === 0) {
      await prisma.projectClientMap.create({
        data: {
          clientId: client.id,
          projectId: salesTax.id,
          active: true,
          createSubtask: true,
          currentPeriod: currentMonthlyPeriod.name,
        },
      });

      for (const [seq, subtask] of salesTaxSubtasks.entries()) {
        const status =
          seq === 0 ? ActivityStatus.DONE : ActivityStatus.NOT_STARTED;
        await prisma.clientActivity.create({
          data: {
            clientId: client.id,
            projectId: salesTax.id,
            subTaskId: subtask.id,
            periodName: currentMonthlyPeriod.name,
            taskSeqNo: seq + 1,
            status,
            assigneeId: staff[(i + 1) % staff.length].id,
          },
        });
        createdActivities++;
      }
    }
  }

  console.log(
    `Seeded ${staff.length} staff, ${clients.length} clients, ${PROJECT_CATALOG.length} project templates, ${createdActivities} activity rows.`
  );
  console.log("");
  console.log("  Admin login:");
  console.log(`    email:    ${ADMIN_EMAIL}`);
  console.log(`    password: ${ADMIN_PASSWORD}`);
  console.log("  Other employees are invite-pending — send them their link from /admin/employees.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
