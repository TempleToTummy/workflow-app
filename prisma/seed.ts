import { PrismaClient, RecurringType, ActivityStatus } from "@prisma/client";
import { hashPassword, newToken, inviteExpiry } from "../src/lib/password";
import { BUILT_IN_TEMPLATES } from "./email-templates";
import { CORPORATION_TYPES, DUE_RULES, PROJECT_CATALOG } from "./catalog";


const prisma = new PrismaClient();

// Dev-only. Documented in README. Change here (and re-seed) to rotate it.
const ADMIN_EMAIL = "admin@workflow.test";
const ADMIN_PASSWORD = "admin1234";


function monthPeriodName(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function monthRange(date: Date): { start: Date; end: Date } {
  const start = new Date(date.getFullYear(), date.getMonth(), 1);
  const end = new Date(date.getFullYear(), date.getMonth() + 1, 0);
  return { start, end };
}

async function main() {
  console.log("Seeding database...");

  await prisma.savedView.deleteMany();
  await prisma.loginChallenge.deleteMany();
  await prisma.tag.deleteMany(); // ClientTag rows cascade
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
    CORPORATION_TYPES.map((name) =>
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

    // Steps are numbered 1, 2, 3… in the source app's order. Each project has
    // its own steps, including its own "Completed Y/N".
    const subtasks = [];
    const ordered = [...def.steps].sort((a, b) => a.seq - b.seq);
    for (const step of ordered) {
      const subtask = await prisma.projectSubTask.create({ data: { name: step.name } });
      subtasks.push(subtask);
    }
    for (const [i, subtask] of subtasks.entries()) {
      await prisma.projectTaskMap.create({
        data: { projectId: project.id, subTaskId: subtask.id, sequence: i + 1 },
      });
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
