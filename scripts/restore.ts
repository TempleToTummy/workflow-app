// Restore a backup from the command line — for when the app itself won't start.
//
//   npm run db:restore -- backups/workflow-backup-2026-09-23-0600.json          (dry run)
//   npm run db:restore -- backups/workflow-backup-2026-09-23-0600.json --yes    (do it)
//
// Replaces ALL data. The current data is snapshotted into backups/ first, the
// whole restore runs in one transaction, and everyone is signed out.
import { readFile } from "node:fs/promises";
import { PrismaClient } from "@prisma/client";
import { restoreBackup } from "../src/lib/backup";
import { checkBackup, SUMMARY_TABLES } from "../src/lib/backup-format";
import { objectStore } from "../src/lib/storage";

async function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--"));
  if (!file) throw new Error("Usage: npm run db:restore -- <backup.json> [--yes]");

  const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
  const check = checkBackup(parsed);
  if (!check.ok) throw new Error(check.error);

  console.log(`Backup made ${check.createdAt}${check.createdBy ? ` by ${check.createdBy}` : ""}:`);
  for (const { table, label } of SUMMARY_TABLES) console.log(`  ${label.padEnd(16)} ${check.counts[table]}`);
  if (check.fileCount) console.log(`  ${"Uploaded files".padEnd(16)} ${check.fileCount}`);

  if (!args.includes("--yes")) {
    console.log("\nDry run — nothing changed. Re-run with --yes to replace ALL current data with this backup.");
    return;
  }

  const prisma = new PrismaClient();
  try {
    const result = await restoreBackup(prisma, parsed, { store: objectStore }).catch((err) => {
      throw new Error(`Restore failed and nothing was changed: ${err instanceof Error ? err.message : err}`);
    });
    console.log(`\nRestored.${result.filesWritten ? ` ${result.filesWritten} files written.` : ""}`);
    if (result.snapshot) console.log(`Previous data saved to ${result.snapshot}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
