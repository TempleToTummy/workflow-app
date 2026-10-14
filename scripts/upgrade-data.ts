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
//   1. Folds every per-project copy of "Completed Y/N" into ONE universal step
//      (ProjectSubTask.systemKey = "COMPLETED"), repointing each project's
//      checklist and every task row at it.
//   2. Runs each project's checklist through normalizeChecklist: numbered
//      1, 2, 3…, the universal step last on every project that has steps,
//      and periods still in progress renumbered to match.
import { PrismaClient } from "@prisma/client";
import { COMPLETED_KEY, COMPLETED_NAME, isCompletedStepName } from "../src/lib/checklist-rules";

const apply = process.argv.includes("--apply");
const prisma = new PrismaClient();
const notes: string[] = [];

async function mergeCompletedSteps() {
  const candidates = (await prisma.projectSubTask.findMany({
    include: { _count: { select: { taskMaps: true, activities: true } } },
  })).filter((s) => s.systemKey === COMPLETED_KEY || isCompletedStepName(s.name));

  if (candidates.length === 0) {
    console.log("  No \"Completed\" steps yet — the first project with steps will create the universal one.");
    return;
  }
  // Keep the one already marked universal, else the most-used copy.
  const canonical =
    candidates.find((s) => s.systemKey === COMPLETED_KEY) ??
    [...candidates].sort(
      (a, b) => b._count.taskMaps + b._count.activities - (a._count.taskMaps + a._count.activities)
    )[0];
  const duplicates = candidates.filter((s) => s.id !== canonical.id);

  console.log(
    `  "Completed" steps found: ${candidates.length} → 1 universal step` +
      (duplicates.length ? ` (${duplicates.length} duplicate${duplicates.length === 1 ? "" : "s"} to merge)` : "")
  );
  if (!apply) return;

  await prisma.projectSubTask.update({
    where: { id: canonical.id },
    data: { systemKey: COMPLETED_KEY, name: COMPLETED_NAME },
  });

  for (const dup of duplicates) {
    const maps = await prisma.projectTaskMap.findMany({ where: { subTaskId: dup.id } });
    for (const m of maps) {
      const already = await prisma.projectTaskMap.findUnique({
        where: { projectId_subTaskId: { projectId: m.projectId, subTaskId: canonical.id } },
      });
      await prisma.$transaction([
        prisma.projectTaskMap.delete({ where: { projectId_subTaskId: { projectId: m.projectId, subTaskId: dup.id } } }),
        ...(already
          ? []
          : [
              prisma.projectTaskMap.create({
                data: {
                  projectId: m.projectId,
                  subTaskId: canonical.id,
                  sequence: m.sequence,
                  defaultAssigneeId: m.defaultAssigneeId,
                  dueOffsetDays: m.dueOffsetDays,
                  estimatedMinutes: m.estimatedMinutes,
                },
              }),
            ]),
      ]);
    }

    const rows = await prisma.clientActivity.findMany({ where: { subTaskId: dup.id } });
    for (const r of rows) {
      const clash = await prisma.clientActivity.findUnique({
        where: {
          clientId_projectId_subTaskId_periodName: {
            clientId: r.clientId,
            projectId: r.projectId,
            subTaskId: canonical.id,
            periodName: r.periodName,
          },
        },
      });
      if (clash) {
        notes.push(`task row ${r.id} (${r.periodName}) duplicates an existing Completed row and was left as is`);
        continue;
      }
      await prisma.clientActivity.update({ where: { id: r.id }, data: { subTaskId: canonical.id } });
    }

    const left = await prisma.clientActivity.count({ where: { subTaskId: dup.id } });
    if (left === 0) await prisma.projectSubTask.delete({ where: { id: dup.id } });
  }
}

async function normalizeAllChecklists() {
  // Imported here so a dry run never touches the app's own Prisma client.
  const { normalizeChecklist } = await import("../src/lib/checklist");
  const projects = await prisma.project.findMany({
    select: { id: true, name: true, subtasks: { orderBy: { sequence: "asc" }, select: { sequence: true } } },
  });
  let changed = 0;
  for (const p of projects) {
    const seqs = p.subtasks.map((s) => s.sequence);
    if (seqs.some((n, i) => n !== i + 1)) changed += 1;
  }
  console.log(`  Projects to renumber 1, 2, 3… with "Completed Y/N" last: ${changed} of ${projects.length} (checked again after merging)`);
  if (!apply) return;
  for (const p of projects) {
    await normalizeChecklist(p.id, { actor: { id: null, label: "Data upgrade" } });
  }
}

async function main() {
  console.log(apply ? "Upgrading data…\n" : "Dry run — nothing will change.\n");
  await mergeCompletedSteps();
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
