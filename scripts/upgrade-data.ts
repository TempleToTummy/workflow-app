// Brings an existing database's data in line with the current rules. Run it
// after `npx prisma db push` whenever the release notes say so.
//
//   npm run db:upgrade              → dry run: report what would change
//   npm run db:upgrade -- --apply   → do it
//
// Idempotent: a second run finds nothing to do. Take a backup first
// (`npm run db:backup`) — this rewrites checklist rows.
//
// What it does today:
//   1. Gives every project its own "Completed Y/N" step again. A short-lived
//      version of the app merged them into one shared step; any such step
//      used by several projects is split back into one copy per project, and
//      each project's task rows are pointed at its own copy.
//   2. Numbers every project's checklist 1, 2, 3… and renumbers the periods
//      still in progress to match.
import { PrismaClient } from "@prisma/client";
import { isCompletedStepName } from "../src/lib/checklist-rules";

const apply = process.argv.includes("--apply");
const prisma = new PrismaClient();
const notes: string[] = [];

async function splitSharedCompletedSteps() {
  const shared = (
    await prisma.projectSubTask.findMany({ include: { taskMaps: { orderBy: { projectId: "asc" } } } })
  ).filter((s) => isCompletedStepName(s.name) && s.taskMaps.length > 1);
  const copies = shared.reduce((n, s) => n + s.taskMaps.length - 1, 0);
  console.log(
    copies === 0
      ? '  "Completed Y/N": every project already has its own.'
      : `  "Completed Y/N": ${shared.length} shared step${shared.length === 1 ? "" : "s"} → ${copies} new per-project cop${copies === 1 ? "y" : "ies"}`
  );
  if (!apply) return;

  for (const step of shared) {
    // The first project keeps the existing row; every other one gets a copy.
    for (const m of step.taskMaps.slice(1)) {
      const copy = await prisma.projectSubTask.create({ data: { name: step.name, note: step.note } });
      await prisma.$transaction([
        prisma.projectTaskMap.delete({ where: { projectId_subTaskId: { projectId: m.projectId, subTaskId: step.id } } }),
        prisma.projectTaskMap.create({
          data: {
            projectId: m.projectId,
            subTaskId: copy.id,
            sequence: m.sequence,
            defaultAssigneeId: m.defaultAssigneeId,
            dueOffsetDays: m.dueOffsetDays,
            estimatedMinutes: m.estimatedMinutes,
          },
        }),
        prisma.clientActivity.updateMany({
          where: { projectId: m.projectId, subTaskId: step.id },
          data: { subTaskId: copy.id },
        }),
      ]);
    }
  }
}

async function normalizeAllChecklists() {
  // Imported here so a dry run never touches the app's own Prisma client.
  const { normalizeChecklist } = await import("../src/lib/checklist");
  const projects = await prisma.project.findMany({
    select: { id: true, subtasks: { orderBy: { sequence: "asc" }, select: { sequence: true } } },
  });
  const changed = projects.filter((p) => p.subtasks.some((s, i) => s.sequence !== i + 1)).length;
  console.log(`  Checklists to renumber 1, 2, 3…: ${changed} of ${projects.length}`);
  if (!apply) return;
  for (const p of projects) {
    await normalizeChecklist(p.id, { actor: { id: null, label: "Data upgrade" } });
  }
}

async function main() {
  console.log(apply ? "Upgrading data…\n" : "Dry run — nothing will change.\n");
  await splitSharedCompletedSteps();
  await normalizeAllChecklists();
  if (notes.length) {
    console.log(`\n${notes.length} item(s) to review:`);
    for (const n of notes) console.log(`  - ${n}`);
  }
  if (!apply) console.log("\nRe-run with --apply to make these changes (take a backup first: npm run db:backup).");
  else console.log("\nDone.");
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
