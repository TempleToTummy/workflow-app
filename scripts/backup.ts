// Take a backup from the command line — for cron, or before anything risky.
//
//   npm run db:backup                         → backups/workflow-backup-<date>.json
//   npm run db:backup -- --files              → …including uploaded files
//   npm run db:backup -- --out /mnt/nas/wf.json
//   npm run db:backup -- --keep 30            → also prune to the newest 30 backups
//
// Same format as Admin → Backup & Restore, and restorable from either place.
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { createBackup, backupDir } from "../src/lib/backup";
import { backupFilename } from "../src/lib/backup-format";
import { objectStore } from "../src/lib/storage";

async function main() {
  const args = process.argv.slice(2);
  const includeFiles = args.includes("--files");
  const outIdx = args.indexOf("--out");
  const keepIdx = args.indexOf("--keep");
  const keep = keepIdx >= 0 ? Number(args[keepIdx + 1]) : null;
  if (keep !== null && (!Number.isInteger(keep) || keep < 1)) {
    throw new Error("--keep needs a whole number of backups to keep, e.g. --keep 30");
  }

  const prisma = new PrismaClient();
  try {
    const backup = await createBackup(prisma, { includeFiles, store: objectStore, createdBy: "npm run db:backup" });
    const out = outIdx >= 0 ? path.resolve(args[outIdx + 1]) : path.join(backupDir(), backupFilename());
    await mkdir(path.dirname(out), { recursive: true });
    await writeFile(out, JSON.stringify(backup));
    const rows = Object.values(backup.tables).reduce((n, t) => n + t.length, 0);
    console.log(`Backed up ${rows} rows${includeFiles ? ` and ${backup.files?.length ?? 0} files` : ""} → ${out}`);

    if (keep !== null) {
      const dir = path.dirname(out);
      const mine = (await readdir(dir)).filter((n) => /^workflow-backup-.*\.json$/.test(n)).sort().reverse();
      for (const old of mine.slice(keep)) {
        await rm(path.join(dir, old));
        console.log(`Pruned ${old}`);
      }
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
