// The backup file format — the pure parts: which tables, in what order, and
// how a file is checked before anything is restored from it. No next/*, no
// Prisma client, so it's covered by scripts/test-backup.ts.
//
// A backup is one JSON document:
//
//   { format: "workflow-backup", version: 1, createdAt, tables: { Name: [rows] },
//     files?: [{ bucket, storageKey, base64 }] }
//
// JSON rather than a copy of the SQLite file, because it has to survive the
// planned move to Postgres: the same file restores into either database.

export const BACKUP_FORMAT = "workflow-backup";
export const BACKUP_VERSION = 1;

// Every table that is backed up, in an order where each table's foreign keys
// point only at tables earlier in the list. Restore inserts in this order and
// deletes in reverse.
//
// Deliberately NOT backed up: Session and LoginChallenge. They're
// credentials for browsers that are signed in right now, and restoring them
// would either resurrect sessions somebody ended or hand them to whoever holds
// the file. Everyone signs in again after a restore.
export const BACKUP_TABLES = [
  "CorporationType",
  "BusinessType",
  "EmployeeType",
  "ProjectRecurring",
  "AccountingPeriod",
  "Employee",
  "Client",
  "Tag",
  "ClientTag",
  "CorpContact",
  "Project",
  "ProjectSubTask",
  "ProjectTaskMap",
  "ProjectClientMap",
  "ClientActivity",
  "ActivitySubtask",
  "AssignmentNote",
  "ClientRequest",
  "Document",
  "SchedulerRun",
  "EmailTemplate",
  "EmailMessage",
  "AuditEvent",
  "TimeEntry",
  "TaskComment",
  "TaskCommentMention",
  "SavedView",
] as const;

export type BackupTable = (typeof BACKUP_TABLES)[number];

// Tables that must exist and be non-empty for a file to be a plausible backup
// of this app. A restore replaces EVERYTHING, so a truncated or hand-edited
// file must be refused rather than half-applied.
const REQUIRED_NON_EMPTY: BackupTable[] = ["Employee", "ProjectRecurring"];

// Employee columns that are credentials for a link somebody may still hold.
// They're stripped on export: an old invite or reset link should not come
// back to life because a backup was restored.
export const EMPLOYEE_SECRET_COLUMNS = [
  "inviteToken",
  "inviteTokenExpiresAt",
  "resetTokenHash",
  "resetTokenExpiresAt",
] as const;

export type BackupFile = {
  format: typeof BACKUP_FORMAT;
  version: number;
  createdAt: string;
  createdBy?: string;
  tables: Record<BackupTable, Record<string, unknown>[]>;
  files?: { bucket: string; storageKey: string; base64: string }[];
};

export type BackupCheck =
  | { ok: true; counts: Record<BackupTable, number>; fileCount: number; createdAt: string; createdBy: string | null }
  | { ok: false; error: string };

// Checks the shape of a parsed file. Returns counts per table so the restore
// screen can show "this file has 42 clients" before anybody commits to it.
export function checkBackup(input: unknown): BackupCheck {
  if (!input || typeof input !== "object") return { ok: false, error: "That isn't a backup file." };
  const b = input as Partial<BackupFile>;
  if (b.format !== BACKUP_FORMAT) {
    return { ok: false, error: "That isn't a Workflow backup file." };
  }
  if (typeof b.version !== "number" || b.version > BACKUP_VERSION) {
    return {
      ok: false,
      error: `This backup was made by a newer version of the app (format ${String(b.version)}). Update the app first.`,
    };
  }
  if (!b.tables || typeof b.tables !== "object") {
    return { ok: false, error: "The backup file has no tables in it." };
  }
  const known = new Set<string>(BACKUP_TABLES);
  const unknown = Object.keys(b.tables).filter((t) => !known.has(t));
  if (unknown.length > 0) {
    return { ok: false, error: `The backup contains tables this app doesn't know: ${unknown.join(", ")}.` };
  }

  const counts = {} as Record<BackupTable, number>;
  for (const table of BACKUP_TABLES) {
    const rows = (b.tables as Record<string, unknown>)[table];
    if (rows === undefined) {
      return { ok: false, error: `The backup is missing the ${table} table.` };
    }
    if (!Array.isArray(rows) || rows.some((r) => !r || typeof r !== "object" || Array.isArray(r))) {
      return { ok: false, error: `The ${table} table in the backup is malformed.` };
    }
    counts[table] = rows.length;
  }
  for (const table of REQUIRED_NON_EMPTY) {
    if (counts[table] === 0) {
      return { ok: false, error: `The backup has no ${table} rows — it doesn't look like a complete backup.` };
    }
  }
  const employees = (b.tables as Record<string, Record<string, unknown>[]>).Employee;
  if (!employees.some((e) => e.role === "ADMIN" && typeof e.passwordHash === "string" && e.passwordHash)) {
    return {
      ok: false,
      error: "The backup has no admin with a password, so nobody could sign in after restoring it.",
    };
  }
  if (b.files !== undefined) {
    if (
      !Array.isArray(b.files) ||
      b.files.some(
        (f) => !f || typeof f.bucket !== "string" || typeof f.storageKey !== "string" || typeof f.base64 !== "string"
      )
    ) {
      return { ok: false, error: "The files section of the backup is malformed." };
    }
  }

  return {
    ok: true,
    counts,
    fileCount: b.files?.length ?? 0,
    createdAt: typeof b.createdAt === "string" ? b.createdAt : "unknown",
    createdBy: typeof b.createdBy === "string" ? b.createdBy : null,
  };
}

// Rows in an order that satisfies self-references. TaskComment is the only
// self-referencing table (a reply points at its root), and threads are one
// level deep, so roots-then-replies is enough.
export function orderRowsForInsert(table: BackupTable, rows: Record<string, unknown>[]) {
  if (table !== "TaskComment") return rows;
  return [...rows.filter((r) => !r.parentId), ...rows.filter((r) => r.parentId)];
}

export function backupFilename(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `workflow-backup-${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(
    now.getHours()
  )}${p(now.getMinutes())}.json`;
}

// The headline numbers shown when previewing a file.
export const SUMMARY_TABLES: { table: BackupTable; label: string }[] = [
  { table: "Client", label: "Clients" },
  { table: "Employee", label: "Employees" },
  { table: "Project", label: "Services" },
  { table: "ClientActivity", label: "Tasks" },
  { table: "Document", label: "Files" },
  { table: "TimeEntry", label: "Time entries" },
  { table: "EmailMessage", label: "Emails" },
  { table: "AuditEvent", label: "History entries" },
];
