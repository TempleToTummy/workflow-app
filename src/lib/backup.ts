import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import type { ObjectStore } from "@/lib/storage";
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  BACKUP_TABLES,
  EMPLOYEE_SECRET_COLUMNS,
  checkBackup,
  orderRowsForInsert,
  backupFilename,
  type BackupFile,
  type BackupTable,
} from "@/lib/backup-format";

// Backup and restore. No next/* imports, and the database client and object
// store are passed in, so the same code runs behind the admin page and in the
// command-line scripts (scripts/backup.ts, scripts/restore.ts).

type Delegate = {
  findMany(args?: unknown): Promise<Record<string, unknown>[]>;
  deleteMany(args?: unknown): Promise<unknown>;
  createMany(args: { data: Record<string, unknown>[] }): Promise<unknown>;
};

type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

function delegate(db: PrismaClient | Tx, table: BackupTable): Delegate {
  const key = table.charAt(0).toLowerCase() + table.slice(1);
  const d = (db as unknown as Record<string, Delegate>)[key];
  if (!d) throw new Error(`No database table called ${table}.`);
  return d;
}

// Where the automatic pre-restore snapshots go. Gitignored; on a real
// deployment point BACKUP_DIR at storage that outlives the server.
export function backupDir(): string {
  return process.env.BACKUP_DIR || path.join(process.cwd(), "backups");
}

export async function createBackup(
  db: PrismaClient,
  options: { includeFiles?: boolean; store?: ObjectStore; createdBy?: string } = {}
): Promise<BackupFile> {
  const tables = {} as BackupFile["tables"];
  for (const table of BACKUP_TABLES) {
    let rows = await delegate(db, table).findMany();
    if (table === "Employee") {
      rows = rows.map((r) => {
        const copy = { ...r };
        for (const col of EMPLOYEE_SECRET_COLUMNS) copy[col] = null;
        return copy;
      });
    }
    tables[table] = rows;
  }

  const backup: BackupFile = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    createdBy: options.createdBy,
    tables,
  };

  if (options.includeFiles && options.store) {
    backup.files = [];
    for (const doc of tables.Document) {
      const bucket = String(doc.bucket);
      const storageKey = String(doc.storageKey);
      try {
        const bytes = await options.store.get(bucket, storageKey);
        backup.files.push({ bucket, storageKey, base64: bytes.toString("base64") });
      } catch {
        // A document row whose bytes are already missing (the download route
        // answers 410 for it). Nothing to back up; the row itself still is.
      }
    }
  }
  return backup;
}

export type RestoreResult = {
  counts: Record<BackupTable, number>;
  filesWritten: number;
  snapshot: string | null;
};

// Replaces EVERYTHING in the database with the backup's contents, in one
// transaction: either the whole restore lands or nothing changes. Before
// touching anything it writes a snapshot of the current data to backupDir(),
// so a restore of the wrong file is itself recoverable.
export async function restoreBackup(
  db: PrismaClient,
  input: unknown,
  options: { store?: ObjectStore; snapshot?: boolean } = {}
): Promise<RestoreResult> {
  const check = checkBackup(input);
  if (!check.ok) throw new Error(check.error);
  const backup = input as BackupFile;

  let snapshot: string | null = null;
  if (options.snapshot !== false) {
    const current = await createBackup(db, { createdBy: "automatic pre-restore snapshot" });
    await mkdir(backupDir(), { recursive: true });
    snapshot = path.join(backupDir(), `pre-restore-${backupFilename().replace(/^workflow-backup-/, "")}`);
    await writeFile(snapshot, JSON.stringify(current));
  }

  let currentTable: BackupTable | null = null;
  try {
    await db.$transaction(
      async (tx) => {
        // Sessions and pending sign-ins go too: they point at employees that
        // may not exist after the restore, and nobody should stay signed in to
        // data that was just swapped out from under them.
        await tx.session.deleteMany();
        await tx.loginChallenge.deleteMany();
        for (const table of [...BACKUP_TABLES].reverse()) {
          await delegate(tx, table).deleteMany();
        }
        for (const table of BACKUP_TABLES) {
          currentTable = table;
          const rows = orderRowsForInsert(table, backup.tables[table]);
          // Chunked: SQLite caps the number of bound parameters per statement.
          for (let i = 0; i < rows.length; i += 200) {
            await delegate(tx, table).createMany({ data: rows.slice(i, i + 200) });
          }
        }
      },
      { timeout: 10 * 60_000, maxWait: 60_000 }
    );
  } catch (err) {
    // The transaction rolled back, so nothing changed. Say that, and say where
    // the file went wrong, instead of surfacing a raw database error.
    const code = err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : "";
    const where = currentTable ? ` in the ${currentTable} table` : "";
    if (code === "P2003") {
      throw new Error(`the backup refers to a record that isn't in it${where} (a broken link between tables).`);
    }
    if (code === "P2002") throw new Error(`the backup contains duplicate records${where}.`);
    const message = err instanceof Error ? err.message.trim().split("\n").pop() : String(err);
    throw new Error(`${message}${where}.`);
  }

  let filesWritten = 0;
  if (backup.files && options.store) {
    for (const f of backup.files) {
      const bytes = Buffer.from(f.base64, "base64");
      await options.store.put(f.bucket, f.storageKey, bytes, "application/octet-stream");
      filesWritten += 1;
    }
  }

  return { counts: check.counts, filesWritten, snapshot };
}

export async function listSnapshots(): Promise<{ name: string; size: number; modifiedAt: Date }[]> {
  try {
    const dir = backupDir();
    const names = (await readdir(dir)).filter((n) => n.endsWith(".json"));
    const stats = await Promise.all(names.map(async (name) => ({ name, s: await stat(path.join(dir, name)) })));
    return stats
      .map(({ name, s }) => ({ name, size: s.size, modifiedAt: s.mtime }))
      .sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
  } catch {
    return [];
  }
}

// A snapshot name from a request, checked so it can't walk out of the folder.
export function snapshotPath(name: string): string | null {
  if (!/^[A-Za-z0-9._-]+\.json$/.test(name)) return null;
  return path.join(backupDir(), name);
}
