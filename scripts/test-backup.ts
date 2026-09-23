// The backup file format: what's in it, and what is refused before a restore
// replaces everything. No framework, no database:
//
//   ./node_modules/.bin/tsx scripts/test-backup.ts
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  BACKUP_TABLES,
  checkBackup,
  orderRowsForInsert,
  backupFilename,
} from "../src/lib/backup-format";
import { check, section, finish } from "./harness";

function validBackup() {
  const tables = Object.fromEntries(BACKUP_TABLES.map((t) => [t, [] as Record<string, unknown>[]]));
  tables.Employee = [{ id: "e1", role: "ADMIN", passwordHash: "salt:hash" }];
  tables.ProjectRecurring = [{ id: "r1", type: "MONTHLY" }];
  tables.Client = [{ id: "c1" }, { id: "c2" }];
  return { format: BACKUP_FORMAT, version: BACKUP_VERSION, createdAt: "2026-09-23T00:00:00.000Z", tables } as Record<string, unknown>;
}
const err = (input: unknown) => {
  const r = checkBackup(input);
  return r.ok ? "ok" : r.error;
};

section("table order");
{
  const idx = (t: string) => BACKUP_TABLES.indexOf(t as (typeof BACKUP_TABLES)[number]);
  // Each pair: [child, parent] — the parent must be inserted first.
  const fks: [string, string][] = [
    ["Client", "CorporationType"],
    ["Employee", "EmployeeType"],
    ["AccountingPeriod", "ProjectRecurring"],
    ["Project", "ProjectRecurring"],
    ["ProjectTaskMap", "Project"],
    ["ProjectTaskMap", "ProjectSubTask"],
    ["ProjectTaskMap", "Employee"],
    ["ProjectClientMap", "Client"],
    ["ClientActivity", "AccountingPeriod"],
    ["ClientActivity", "ProjectSubTask"],
    ["ActivitySubtask", "ClientActivity"],
    ["ClientRequest", "ClientActivity"],
    ["Document", "ClientRequest"],
    ["TimeEntry", "ClientActivity"],
    ["TaskComment", "ClientActivity"],
    ["TaskCommentMention", "TaskComment"],
    ["ClientTag", "Tag"],
    ["ClientTag", "Client"],
    ["SavedView", "Employee"],
    ["CorpContact", "Client"],
  ];
  for (const [child, parent] of fks) {
    check(`${parent} before ${child}`, idx(parent) >= 0 && idx(parent) < idx(child), true);
  }
  check("sessions are never backed up", BACKUP_TABLES.includes("Session" as never), false);
  check("no table listed twice", new Set(BACKUP_TABLES).size, BACKUP_TABLES.length);
}

section("checkBackup — accepts");
{
  const r = checkBackup(validBackup());
  check("a well-formed backup", r.ok, true);
  check("counts rows per table", r.ok ? r.counts.Client : null, 2);
  check("reports no files", r.ok ? r.fileCount : null, 0);
  const withFiles = { ...validBackup(), files: [{ bucket: "b", storageKey: "k", base64: "aGk=" }] };
  const f = checkBackup(withFiles);
  check("counts included files", f.ok ? f.fileCount : null, 1);
  check("an older format version is fine", checkBackup({ ...validBackup(), version: 0 }).ok, true);
}

section("checkBackup — refuses");
check("null", err(null), "That isn't a backup file.");
check("a random JSON object", err({ hello: "world" }), "That isn't a Workflow backup file.");
check(
  "a newer format",
  err({ ...validBackup(), version: BACKUP_VERSION + 1 }),
  `This backup was made by a newer version of the app (format ${BACKUP_VERSION + 1}). Update the app first.`
);
check("no tables", err({ ...validBackup(), tables: undefined }), "The backup file has no tables in it.");
{
  const b = validBackup();
  const tables = { ...(b.tables as Record<string, unknown>) };
  delete tables.TimeEntry;
  check("a missing table", err({ ...b, tables }), "The backup is missing the TimeEntry table.");
}
{
  const b = validBackup();
  check(
    "an unknown table",
    err({ ...b, tables: { ...(b.tables as object), Hackers: [] } }),
    "The backup contains tables this app doesn't know: Hackers."
  );
  check(
    "a table that isn't an array",
    err({ ...b, tables: { ...(b.tables as object), Client: { id: 1 } } }),
    "The Client table in the backup is malformed."
  );
  check(
    "rows that aren't objects",
    err({ ...b, tables: { ...(b.tables as object), Client: ["c1"] } }),
    "The Client table in the backup is malformed."
  );
  check(
    "no employees at all",
    err({ ...b, tables: { ...(b.tables as object), Employee: [] } }),
    "The backup has no Employee rows — it doesn't look like a complete backup."
  );
  check(
    "no admin who could sign in",
    err({ ...b, tables: { ...(b.tables as object), Employee: [{ id: "e", role: "ADMIN", passwordHash: null }] } }),
    "The backup has no admin with a password, so nobody could sign in after restoring it."
  );
  check(
    "a malformed files section",
    err({ ...b, files: [{ bucket: "b" }] }),
    "The files section of the backup is malformed."
  );
}

section("insert order within a table");
check(
  "comment roots go before replies",
  orderRowsForInsert("TaskComment", [
    { id: "r1", parentId: "c1" },
    { id: "c1", parentId: null },
    { id: "r2", parentId: "c1" },
  ]).map((r) => r.id),
  ["c1", "r1", "r2"]
);
check("other tables keep their order", orderRowsForInsert("Client", [{ id: "b" }, { id: "a" }]).map((r) => r.id), ["b", "a"]);

section("filenames");
check("dated and sortable", backupFilename(new Date(2026, 8, 3, 6, 5)), "workflow-backup-2026-09-03-0605.json");

finish();
