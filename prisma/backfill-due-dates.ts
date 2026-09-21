import { PrismaClient } from "@prisma/client";
import { resolveStepDueDates } from "../src/lib/due-dates";

// One-off migration for a database that predates due-date rules.
//
// Every ClientActivity created before this feature has dueDate = null, and
// every Project has the default rule (0 = due the last day of the period,
// which is what the app used to hardcode). This script:
//
//   1. applies the federal statutory deadlines to the services that have one,
//      matching the DUE_RULES table in seed.ts;
//   2. resolves and writes dueDate onto every existing task row.
//
// Idempotent — re-running it recomputes the same dates. It never touches a row
// flagged dueDateOverridden, so a date someone set by hand survives.
//
//   ./node_modules/.bin/tsx prisma/backfill-due-dates.ts

const prisma = new PrismaClient();

// Federal statutory deadlines only, as offsets from a Dec 31 year end.
// Anything not listed keeps 0 for the firm to set on the project page.
const DUE_RULES: Record<string, number> = {
  "1099 Form": 31, // Jan 31
  "Business Tax Return": 74, // Mar 15
  "Individual Tax Return": 105, // Apr 15
  "Tax Return Extension": 105,
};

async function main() {
  let rulesApplied = 0;
  for (const [name, days] of Object.entries(DUE_RULES)) {
    const result = await prisma.project.updateMany({
      where: { name, dueOffsetDays: 0 },
      data: { dueOffsetDays: days },
    });
    if (result.count > 0) {
      rulesApplied += result.count;
      console.log(`  rule: ${name} → due ${days} days after period end`);
    }
  }
  console.log(`Applied ${rulesApplied} statutory due-date rule(s).`);

  const projects = await prisma.project.findMany({
    select: { id: true, name: true, dueOffsetDays: true },
  });
  const periods = await prisma.accountingPeriod.findMany({
    select: { name: true, endDate: true },
  });
  const periodEnd = new Map(periods.map((p) => [p.name, p.endDate]));

  let written = 0;
  for (const project of projects) {
    const [taskMaps, assignments, activities] = await Promise.all([
      prisma.projectTaskMap.findMany({
        where: { projectId: project.id },
        select: { subTaskId: true, dueOffsetDays: true },
      }),
      prisma.projectClientMap.findMany({
        where: { projectId: project.id },
        select: { clientId: true, dueOffsetDays: true },
      }),
      prisma.clientActivity.findMany({
        where: { projectId: project.id, dueDateOverridden: false },
        select: { id: true, clientId: true, subTaskId: true, periodName: true, dueDate: true },
      }),
    ]);
    if (activities.length === 0) continue;

    const overrideByClient = new Map(assignments.map((a) => [a.clientId, a.dueOffsetDays]));
    const cache = new Map<string, Map<string, Date>>();

    // Batch rows landing on the same date into one updateMany.
    const byDate = new Map<number, string[]>();
    for (const a of activities) {
      const key = `${a.clientId}:${a.periodName}`;
      let dates = cache.get(key);
      if (!dates) {
        const end = periodEnd.get(a.periodName);
        if (!end) continue;
        dates = resolveStepDueDates({
          periodEnd: end,
          projectOffset: project.dueOffsetDays,
          clientOverride: overrideByClient.get(a.clientId) ?? null,
          steps: taskMaps,
        });
        cache.set(key, dates);
      }
      const next = dates.get(a.subTaskId);
      if (!next) continue;
      if (a.dueDate && a.dueDate.getTime() === next.getTime()) continue;
      const bucket = byDate.get(next.getTime());
      if (bucket) bucket.push(a.id);
      else byDate.set(next.getTime(), [a.id]);
    }

    for (const [time, ids] of byDate) {
      await prisma.clientActivity.updateMany({
        where: { id: { in: ids } },
        data: { dueDate: new Date(time) },
      });
      written += ids.length;
    }
    if (byDate.size > 0) {
      console.log(`  ${project.name}: ${[...byDate.values()].flat().length} rows dated`);
    }
  }

  console.log(`Wrote ${written} due date(s).`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
