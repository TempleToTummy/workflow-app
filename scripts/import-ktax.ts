// Import the KTAX (Oracle APEX) export into this app.
//
//   npm run import:ktax -- path/to/ktax_export.zip                  (dry run: report only)
//   npm run import:ktax -- path/to/ktax_export.zip --commit         (do it)
//
// The path can be the zip the APEX export page downloads, or a folder with the
// CSVs unzipped into it. Extra options, both repeatable, for source values the
// importer won't guess at (the dry run says when they're needed):
//
//   --status "Hold=IN_PROGRESS"        what a KTAX task status means here
//   --recurring "7=MONTHLY"            what a KTAX cadence (PROJECT_RECURRING id or code) means
//
// --commit REPLACES all data in the app with the KTAX data, exactly like a
// backup restore: the current data is snapshotted into backups/ first, the
// whole import runs in one transaction, and everyone is signed out. Admin
// accounts, email templates and project due-date rules are carried across.
// See src/lib/ktax-import.ts for every mapping rule.
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { BACKUP_FORMAT, BACKUP_VERSION, type BackupFile } from "../src/lib/backup-format";
import { restoreBackup } from "../src/lib/backup";
import {
  parseCsv,
  parseRecurringArgs,
  parseStatusArgs,
  transformKtax,
  type ImportReport,
  type SourceTables,
} from "../src/lib/ktax-import";
import { objectStore } from "../src/lib/storage";
import { readZip } from "../src/lib/zip-read";

function parseArgs(argv: string[]) {
  let input: string | null = null;
  let commit = false;
  const status: string[] = [];
  const recurring: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--commit") commit = true;
    else if (a === "--status" || a === "--recurring") {
      const v = argv[++i];
      if (!v) throw new Error(`${a} needs a value, e.g. ${a} "VALUE=TYPE"`);
      (a === "--status" ? status : recurring).push(v);
    } else if (a.startsWith("--")) throw new Error(`Unknown option ${a}`);
    else input = a;
  }
  if (!input) {
    throw new Error("Usage: npm run import:ktax -- <ktax_export.zip | folder> [--commit] [--status X=Y] [--recurring X=Y]");
  }
  return { input, commit, status, recurring };
}

// Table name → CSV text, from either the zip or a folder of CSVs.
async function readSource(input: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const info = await stat(input).catch(() => null);
  if (!info) throw new Error(`Can't find ${input}`);
  const add = (name: string, bytes: Buffer) => {
    const base = path.basename(name);
    if (!/\.csv$/i.test(base)) return;
    files.set(base.replace(/\.csv$/i, "").toUpperCase(), bytes.toString("utf8"));
  };
  if (info.isDirectory()) {
    for (const name of await readdir(input)) add(name, await readFile(path.join(input, name)));
  } else {
    for (const [name, bytes] of readZip(await readFile(input))) add(name, bytes);
  }
  if (files.size === 0) throw new Error(`No CSV files found in ${input}`);
  return files;
}

function printReport(report: ImportReport) {
  const line = (s = "") => console.log(s);

  line("Files");
  line(`  ${"table".padEnd(22)} ${"rows".padStart(7)} ${"expected".padStart(9)} ${"importing".padStart(10)}`);
  for (const s of report.source) {
    line(
      `  ${s.table.padEnd(22)} ${String(s.read).padStart(7)} ${String(s.expected ?? "?").padStart(9)} ${String(
        s.imported ?? "-"
      ).padStart(10)}`
    );
  }
  line("  (the numbers can differ for good reasons: duplicates merged, broken links skipped — see Warnings)");

  line("\nCadences (KTAX PROJECT_RECURRING → app)");
  for (const r of report.recurringMapping) {
    line(`  #${r.oldId.padEnd(4)} ${JSON.stringify(r.code ?? "").padEnd(14)} → ${(r.type ?? "??").padEnd(10)} ${r.how}`);
  }

  line("\nTask statuses (KTAX CLIENT_ACTIVITY.STATUS → app)   ← check these");
  for (const s of report.statusMapping) {
    line(`  ${JSON.stringify(s.value).padEnd(20)} → ${s.status.padEnd(16)} ${String(s.rows).padStart(7)} rows${s.how === "override" ? "  (--status)" : ""}`);
  }

  if (report.periodRenames.length) {
    line(`\nPeriods renamed to the app's format (${report.periodRenames.length}), for example:`);
    for (const r of report.periodRenames.slice(0, 6)) line(`  ${r.from.padEnd(20)} → ${r.to}`);
  }

  if (report.warnings.length) {
    line("\nWarnings (imported anyway — examples are KTAX ids)");
    for (const w of report.warnings) {
      line(`  • ${w.message}: ${w.count}${w.examples.length ? `  e.g. ${w.examples.join(", ")}` : ""}`);
    }
  }

  if (report.notes.length) {
    line("\nNotes");
    for (const n of report.notes) line(`  • ${n}`);
  }

  const c = report.catchUp;
  if (c.engagements || c.tooFarBehind) {
    line("\nAfter the import");
    if (c.engagements) {
      line(
        `  • The first time the app runs work generation it will create about ${c.rows} Not Started tasks for ` +
          `${c.engagements} active engagements: ${c.periods} new periods up to today, plus steps missing from their current period.`
      );
      const b = c.breakdown;
      const part = (label: string, v: { engagements: number; rows: number }) =>
        v.rows ? line(`      ${label.padEnd(48)} ${String(v.rows).padStart(7)} tasks, ${v.engagements} engagements`) : undefined;
      line("    Where they come from:");
      if (b.newPeriods) line(`      ${"new periods between KTAX's current one and today".padEnd(48)} ${String(b.newPeriods).padStart(7)} tasks`);
      part("current period has NO rows in KTAX", b.currentPeriodEmpty);
      part("current period is missing some steps in KTAX", b.currentPeriodGaps);
      if (b.noCurrentPeriod.rows || b.createSubtaskOff.rows) {
        line("    Overlapping with the above:");
        part("CURRENT_PERIOD blank in KTAX (starts at today)", b.noCurrentPeriod);
        part("CREATE_SUBTASK = N in KTAX", b.createSubtaskOff);
      }
      line("    By service:");
      for (const p of b.byProject) line(`      ${p.project.padEnd(48)} ${String(p.rows).padStart(7)} tasks, ${p.engagements} engagements`);
      line("    That's normal if KTAX was up to date. If the number looks too big, some engagements are probably");
      line("    marked active in KTAX but no longer worked — say so before committing.");
    }
    if (c.tooFarBehind) {
      line(`  • ${c.tooFarBehind} active engagements are more than 60 periods behind; the app will leave them alone and list them.`);
    }
  }

  if (report.blockers.length) {
    line("\nCAN'T IMPORT YET");
    for (const b of report.blockers) line(`  ✗ ${b}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const statusOverrides = parseStatusArgs(args.status);
  const recurringOverrides = parseRecurringArgs(args.recurring);

  const files = await readSource(args.input);
  const source: SourceTables = {};
  const fileErrors: string[] = [];
  for (const [table, csv] of files) {
    try {
      source[table] = parseCsv(csv);
    } catch (err) {
      fileErrors.push(`${table}.csv: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const prisma = new PrismaClient();
  try {
    const [keepAdmins, keepEmailTemplates, projects, currentClients, currentTasks] = await Promise.all([
      prisma.employee.findMany({ where: { role: "ADMIN", passwordHash: { not: null } } }),
      prisma.emailTemplate.findMany(),
      prisma.project.findMany({ include: { subtasks: { include: { subTask: true } } } }),
      prisma.client.count(),
      prisma.clientActivity.count(),
    ]);

    const { tables, report } = transformKtax(source, {
      keepAdmins,
      keepEmailTemplates,
      projectSettings: projects.map((p) => ({
        name: p.name,
        dueOffsetDays: p.dueOffsetDays,
        steps: p.subtasks.map((s) => ({
          name: s.subTask.name,
          dueOffsetDays: s.dueOffsetDays,
          estimatedMinutes: s.estimatedMinutes,
        })),
      })),
      statusOverrides,
      recurringOverrides,
    });
    report.blockers.unshift(...fileErrors);

    printReport(report);

    if (report.blockers.length) {
      console.log("\nNothing was changed.");
      process.exitCode = 1;
      return;
    }

    console.log("\nWill import");
    console.log(
      `  ${tables.Client.length} clients, ${tables.CorpContact.length} contacts, ${tables.Project.length} projects, ` +
        `${tables.ClientActivity.length} tasks, ${tables.Employee.length - keepAdmins.length} employees`
    );
    console.log(`  Keeping ${keepAdmins.length} admin login(s): ${keepAdmins.map((a) => a.email).join(", ")}`);

    if (!args.commit) {
      console.log(
        `\nDry run — nothing changed. --commit will REPLACE everything currently in the app ` +
          `(${currentClients} clients, ${currentTasks} tasks) with the KTAX data. A snapshot is saved to backups/ first.`
      );
      return;
    }

    const backup: BackupFile = {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      createdAt: new Date().toISOString(),
      createdBy: "KTAX import",
      tables,
    };
    const result = await restoreBackup(prisma, backup, { store: objectStore }).catch((err) => {
      throw new Error(`Import failed and nothing was changed: ${err instanceof Error ? err.message : err}`);
    });
    console.log("\nImported.");
    if (result.snapshot) console.log(`The data that was in the app before is saved in ${result.snapshot}`);
    console.log("Next: sign in as admin, check a few clients against KTAX, then invite employees from Admin → Employees.");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
