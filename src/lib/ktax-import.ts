import type { ActivityStatus, RecurringType } from "@prisma/client";
import { BACKUP_TABLES, type BackupTable } from "@/lib/backup-format";
import { currentPeriodName, isPeriodBefore, nextPeriodName, periodRangeForName } from "@/lib/period-names";
import { resolveStepDueDates } from "@/lib/due-dates";

// One-time migration from the live KTAX Oracle APEX app. Pure: no next/*, no
// Prisma client, no filesystem, so scripts/test-ktax-import.ts covers every
// rule here directly. scripts/import-ktax.ts does the reading and writing.
//
// The input is the zip the throwaway APEX export page produces: one CSV per
// table (named after the Oracle table, header row = column names), dates as
// "YYYY-MM-DDTHH:MM:SS", SSN and password columns already dropped at the
// source, plus _ROW_COUNTS.csv (TABLE_NAME,ROW_COUNT) taken in the same run.
//
// The output is a complete backup file (src/lib/backup-format.ts), loaded
// through restoreBackup: the same table order, the same single transaction
// and the same automatic pre-restore snapshot as Admin → Backup & Restore.
// That means an import REPLACES everything, which is what a cutover wants and
// what makes it safely re-runnable. Two things from the current database are
// carried across rather than lost: admin accounts that can sign in (someone
// has to be able to log in afterwards) and the email templates (app
// configuration, not KTAX data). Project due-date rules and step estimates
// are carried across by name for the same reason.
//
// Nothing is guessed silently. Anything that can't be mapped cleanly is
// either a blocker (the import refuses to run) or a counted warning with
// source ids as examples. Examples never quote field values, so the report
// is safe to paste into a chat or a ticket.

export type SourceRow = Record<string, string | null>;
export type SourceTables = Record<string, SourceRow[]>;
type Row = Record<string, unknown>;

export const KTAX_TABLES = [
  "ACCOUNTING_PERIOD",
  "BUSINESS_TYPE",
  "CLIENT",
  "CLIENT_ACTIVITY",
  "CLIENT_TAX_EXTENSION",
  "CORPORATION_TYPE",
  "CORP_CONTACT",
  "EMPLOYEES",
  "EMPLOYEE_TYPE",
  "PROJECT",
  "PROJECT_CLIENT_MAP",
  "PROJECT_RECURRING",
  "PROJECT_SUB_TASK",
  "PROJECT_TASK_MAP",
] as const;

// Exported but deliberately not imported: there is no model for tax
// extensions yet (see the schema header). Reported, never silently dropped.
const NOT_IMPORTED = new Set(["CLIENT_TAX_EXTENSION"]);

// --- CSV --------------------------------------------------------------------

// RFC 4180: quoted fields, doubled quotes, commas and newlines inside quotes,
// CRLF or LF, and a leading UTF-8 BOM. Returns one object per data row keyed
// by the header; an empty field is null (Oracle has no empty string anyway).
export function parseCsv(text: string): SourceRow[] {
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let quoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;

  for (; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      record.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      record.push(field);
      records.push(record);
      record = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (quoted) throw new Error("the file ends inside a quoted field (it looks cut off)");
  if (field !== "" || record.length > 0) {
    record.push(field);
    records.push(record);
  }

  const nonEmpty = records.filter((r) => !(r.length === 1 && r[0] === ""));
  if (nonEmpty.length === 0) return [];
  const header = nonEmpty[0].map((h) => h.trim().toUpperCase());
  return nonEmpty.slice(1).map((values, n) => {
    if (values.length !== header.length) {
      throw new Error(`row ${n + 2} has ${values.length} fields but the header has ${header.length}`);
    }
    const row: SourceRow = {};
    header.forEach((h, idx) => {
      row[h] = values[idx] === "" ? null : values[idx];
    });
    return row;
  });
}

// --- Value helpers ------------------------------------------------------------

function text(row: SourceRow, col: string): string | null {
  const v = row[col];
  if (v === null || v === undefined) return null;
  // CHAR columns come back space-padded, and hand-typed values carry stray
  // whitespace; neither is meaningful.
  const t = v.trim();
  return t === "" ? null : t;
}

// Oracle DATE has no time zone. The app stores period boundaries as local
// midnight (src/lib/due-dates.ts), so source dates are read as local time too;
// reading them as UTC would move dates a day for anyone west of Greenwich.
export function parseSourceDate(value: string | null): Date | null | "invalid" {
  if (value === null) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(value.trim());
  if (!m) return "invalid";
  const [y, mo, d, h, mi, s] = m.slice(1).map((x) => (x === undefined ? 0 : Number(x)));
  const date = new Date(y, mo - 1, d, h, mi, s);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return "invalid";
  return date;
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// Y/N flags. Blank means the column's default; anything unrecognised is
// reported by the caller.
function flag(value: string | null): boolean | null | "unknown" {
  if (value === null) return null;
  const v = value.trim().toUpperCase();
  if (["Y", "YES", "T", "TRUE", "1", "A", "ACTIVE"].includes(v)) return true;
  if (["N", "NO", "F", "FALSE", "0", "I", "INACTIVE"].includes(v)) return false;
  return "unknown";
}

const key = (kind: string, oldId: string) => `ktax-${kind}-${oldId}`;
const norm = (s: string) => s.trim().toUpperCase().replace(/[\s_-]+/g, " ");

// --- Mappings for coded values --------------------------------------------------

// The source stores cadence as a short CHAR code. These are the spellings
// that are unambiguous; anything else is inferred from the lengths of that
// cadence's accounting periods, and failing that it's a blocker that names
// the code so it can be mapped by hand (--recurring).
const RECURRING_CODES: Record<string, RecurringType> = {
  M: "MONTHLY",
  MO: "MONTHLY",
  MON: "MONTHLY",
  MONTH: "MONTHLY",
  MONTHLY: "MONTHLY",
  Q: "QUARTERLY",
  QTR: "QUARTERLY",
  QUARTER: "QUARTERLY",
  QUARTERLY: "QUARTERLY",
  A: "ANNUAL",
  Y: "ANNUAL",
  YR: "ANNUAL",
  YEAR: "ANNUAL",
  YEARLY: "ANNUAL",
  ANNUAL: "ANNUAL",
  ANNUALLY: "ANNUAL",
  O: "ONE_TIME",
  OT: "ONE_TIME",
  ONCE: "ONE_TIME",
  "ONE TIME": "ONE_TIME",
  ONETIME: "ONE_TIME",
};

// Status spellings with one obvious meaning. Deliberately absent: "P" (pending
// or in progress?) and anything else a person would have to think about. An
// unmapped status is a blocker, fixed with --status "VALUE=STATUS".
const STATUS_CODES: Record<string, ActivityStatus> = {
  N: "NOT_STARTED",
  NO: "NOT_STARTED",
  "NOT STARTED": "NOT_STARTED",
  NOTSTARTED: "NOT_STARTED",
  NEW: "NOT_STARTED",
  OPEN: "NOT_STARTED",
  PENDING: "NOT_STARTED",
  TODO: "NOT_STARTED",
  "TO DO": "NOT_STARTED",
  "IN PROGRESS": "IN_PROGRESS",
  INPROGRESS: "IN_PROGRESS",
  "IN PROCESS": "IN_PROGRESS",
  STARTED: "IN_PROGRESS",
  WIP: "IN_PROGRESS",
  WORKING: "IN_PROGRESS",
  ONGOING: "IN_PROGRESS",
  "AWAITING REVIEW": "AWAITING_REVIEW",
  "IN REVIEW": "AWAITING_REVIEW",
  "PENDING REVIEW": "AWAITING_REVIEW",
  "READY FOR REVIEW": "AWAITING_REVIEW",
  REVIEW: "AWAITING_REVIEW",
  Y: "DONE",
  YES: "DONE",
  DONE: "DONE",
  COMPLETE: "DONE",
  COMPLETED: "DONE",
  CLOSED: "DONE",
  FINISHED: "DONE",
};

const RECURRING_TYPES: RecurringType[] = ["MONTHLY", "QUARTERLY", "ANNUAL", "ONE_TIME"];
const ACTIVITY_STATUSES: ActivityStatus[] = ["NOT_STARTED", "IN_PROGRESS", "AWAITING_REVIEW", "DONE"];

// Parses "CODE=TYPE" pairs from the command line. Keys are normalised the same
// way source values are, so "in progress", "IN_PROGRESS" and "In-Progress"
// all match the same source value.
export function parseMappingArgs<T extends string>(pairs: string[], allowed: readonly T[], what: string) {
  const out: Record<string, T> = {};
  for (const pair of pairs) {
    const at = pair.lastIndexOf("=");
    const target = at === -1 ? "" : pair.slice(at + 1).trim().toUpperCase().replace(/[\s-]+/g, "_");
    if (at <= 0 || !allowed.includes(target as T)) {
      throw new Error(`Can't read ${what} mapping "${pair}". Use VALUE=${allowed.join("|")}.`);
    }
    out[norm(pair.slice(0, at))] = target as T;
  }
  return out;
}

export function parseStatusArgs(pairs: string[]) {
  return parseMappingArgs(pairs, ACTIVITY_STATUSES, "status");
}
export function parseRecurringArgs(pairs: string[]) {
  return parseMappingArgs(pairs, RECURRING_TYPES, "cadence");
}

// A name in the app's own period format for that cadence ("2026-08",
// "2026-Q3", "2026", "ONE-TIME"). Only these can be walked forward by the
// scheduler and the rollover, which is why every source period is renamed.
export function periodNameFits(type: RecurringType, name: string): boolean {
  switch (type) {
    case "MONTHLY":
      return /^\d{4}-(0[1-9]|1[0-2])$/.test(name);
    case "QUARTERLY":
      return /^\d{4}-Q[1-4]$/.test(name);
    case "ANNUAL":
      return /^\d{4}$/.test(name);
    case "ONE_TIME":
      return name === "ONE-TIME";
  }
}

// Classifies one period by its length in days, inclusive.
function cadenceFromLength(start: Date, end: Date): RecurringType | null {
  const days = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
  if (days >= 28 && days <= 31) return "MONTHLY";
  if (days >= 89 && days <= 92) return "QUARTERLY";
  if (days >= 365 && days <= 366) return "ANNUAL";
  return null;
}

// --- Sensitive text -------------------------------------------------------------

// A dashed or spaced SSN in free text is unambiguous enough to remove. A bare
// nine-digit run could equally be an undashed EIN or an account number, so
// it's reported for a human to look at instead of being changed.
const SSN_SHAPED = /(?<!\d)\d{3}[- ]\d{2}[- ]\d{4}(?!\d)/g;
const NINE_DIGITS = /(?<![\d-])\d{9}(?![\d-])/;
export const SSN_REDACTION = "[SSN removed]";

export function redactSsns(value: string): { text: string; removed: number } {
  let removed = 0;
  const out = value.replace(SSN_SHAPED, () => {
    removed += 1;
    return SSN_REDACTION;
  });
  return { text: out, removed };
}

// --- Report -------------------------------------------------------------------

export type Issue = { message: string; count: number; examples: string[] };

export type ImportReport = {
  blockers: string[];
  warnings: Issue[];
  notes: string[];
  // Per source table: rows read, and how many went in.
  source: { table: string; read: number; expected: number | null; imported: number | null }[];
  statusMapping: { value: string; status: ActivityStatus; rows: number; how: "code" | "override" }[];
  recurringMapping: { oldId: string; code: string | null; type: RecurringType | null; how: string }[];
  periodRenames: { from: string; to: string }[];
  // What the scheduler will generate the first time the app runs after the
  // import, so a flood of "late" rows isn't a surprise.
  catchUp: { engagements: number; periods: number; rows: number; tooFarBehind: number };
};

class Issues {
  private map = new Map<string, Issue>();
  add(message: string, example?: string) {
    const issue = this.map.get(message) ?? { message, count: 0, examples: [] };
    issue.count += 1;
    if (example !== undefined && issue.examples.length < 5) issue.examples.push(example);
    this.map.set(message, issue);
  }
  list(): Issue[] {
    return [...this.map.values()];
  }
}

// --- The transform ----------------------------------------------------------------

export type ImportContext = {
  // Admin accounts from the current database, full rows. Kept so somebody can
  // sign in after the import (and restoreBackup refuses a file without one).
  keepAdmins: Row[];
  // App configuration that isn't KTAX data.
  keepEmailTemplates: Row[];
  // Due-date rules and step estimates set up in the new app, matched to
  // imported projects and steps by name.
  projectSettings: {
    name: string;
    dueOffsetDays: number;
    steps: { name: string; dueOffsetDays: number | null; estimatedMinutes: number | null }[];
  }[];
  statusOverrides?: Record<string, ActivityStatus>;
  recurringOverrides?: Record<string, RecurringType>;
  now?: Date;
};

export type ImportResult = {
  tables: Record<BackupTable, Row[]>;
  report: ImportReport;
};

export function transformKtax(source: SourceTables, ctx: ImportContext): ImportResult {
  const now = ctx.now ?? new Date();
  const blockers: string[] = [];
  const notes: string[] = [];
  const issues = new Issues();
  const statusOverrides = ctx.statusOverrides ?? {};
  const recurringOverrides = ctx.recurringOverrides ?? {};

  const rows = (table: string) => source[table] ?? [];

  // --- Completeness ---------------------------------------------------------
  const counts = source._ROW_COUNTS;
  const expected = new Map<string, number>();
  if (counts) {
    for (const r of counts) {
      const t = text(r, "TABLE_NAME");
      const n = Number(text(r, "ROW_COUNT"));
      if (t && Number.isFinite(n)) expected.set(t.toUpperCase(), n);
    }
  } else {
    issues.add("_ROW_COUNTS.csv is missing, so the files can't be checked for completeness");
  }
  for (const table of KTAX_TABLES) {
    if (!source[table]) {
      if (NOT_IMPORTED.has(table)) continue;
      blockers.push(`${table}.csv is missing from the export.`);
      continue;
    }
    const want = expected.get(table);
    if (want !== undefined && want !== source[table].length) {
      blockers.push(
        `${table}.csv has ${source[table].length} rows but the export counted ${want}. ` +
          `The file is incomplete, or the data changed while the export ran — export again.`
      );
    }
  }

  // Every column the transform reads. A renamed or missing column would
  // otherwise import as a quiet column of nulls.
  const REQUIRED_COLUMNS: Record<string, string[]> = {
    ACCOUNTING_PERIOD: ["PERIOD_NAME", "PERIOD_START_DATE", "PERIOD_END_DATE", "RECURRING_ID"],
    BUSINESS_TYPE: ["BUSINESS_TYPE_ID", "BUSINESS_TYPE"],
    CLIENT: ["CLIENT_ID", "COMPANY_NAME", "CORP_TYPE_ID", "BUSINESS_TYPE_ID", "FIN_NO"],
    CLIENT_ACTIVITY: ["ACTIVITY_ID", "CLIENT_ID", "PERIOD_NAME", "PROJECT_ID", "SUB_TASK_ID", "STATUS"],
    CORPORATION_TYPE: ["CORP_TYPE_ID", "CORP_TYPE"],
    CORP_CONTACT: ["CORP_CONTACT_ID", "CLIENT_ID"],
    EMPLOYEES: ["EMPLOYEE_ID", "FIRST_NAME", "LAST_NAME", "EMAIL"],
    EMPLOYEE_TYPE: ["EMPLOYEE_TYPE_ID", "EMPLOYEE_TYPE_NAME"],
    PROJECT: ["PROJECT_ID", "PROJECT_NAME", "RECURRING_ID"],
    PROJECT_CLIENT_MAP: ["CLIENT_ID", "PROJECT_ID"],
    PROJECT_RECURRING: ["RECURRING_ID", "RECURRING_TYPE"],
    PROJECT_SUB_TASK: ["PROJECT_SUB_TASK_ID", "SUB_TASK_NAME"],
    PROJECT_TASK_MAP: ["PROJECT_ID", "PROJECT_SUB_TASK_ID", "TASK_SEQ_NO"],
  };
  for (const [table, cols] of Object.entries(REQUIRED_COLUMNS)) {
    const first = source[table]?.[0];
    if (!first) continue;
    const missing = cols.filter((c) => !(c in first));
    if (missing.length) blockers.push(`${table}.csv has no ${missing.join(", ")} column.`);
  }

  // Values that must never have been exported. The APEX page filters them by
  // column name; this is the second lock on that door.
  for (const table of KTAX_TABLES) {
    const first = source[table]?.[0];
    if (!first) continue;
    const bad = Object.keys(first).filter((c) => /SSN|PASSWORD|PWD/.test(c));
    if (bad.length) {
      blockers.push(`${table}.csv contains ${bad.join(", ")} — sensitive columns must be left out of the export.`);
    }
  }

  const date = (row: SourceRow, col: string, table: string, id: string): Date | null => {
    const d = parseSourceDate(row[col] ?? null);
    if (d === "invalid") {
      issues.add(`${table}.${col}: unreadable date, left blank`, id);
      return null;
    }
    return d;
  };

  // Free text is scanned for SSNs on the way in. The schema's rule is that no
  // SSN is stored in plain text, and a column filter can't see inside a note.
  let ssnsRemoved = 0;
  const cleanText = (value: string | null, table: string, col: string, id: string): string | null => {
    if (value === null) return null;
    const { text: out, removed } = redactSsns(value);
    if (removed) {
      ssnsRemoved += removed;
      issues.add(`${table}.${col}: SSN-shaped number removed (replaced with "${SSN_REDACTION}")`, id);
    }
    if (NINE_DIGITS.test(out)) {
      issues.add(`${table}.${col}: contains a 9-digit number that could be an SSN — left as is, check by hand`, id);
    }
    return out;
  };

  const stamps = (row: SourceRow, table: string, id: string) => {
    const created = date(row, "CREATION_DATE", table, id);
    const updated = date(row, "LAST_UPDATE_DATE", table, id);
    return { createdAt: created ?? now, updatedAt: updated ?? created ?? now };
  };

  // --- Lookups -----------------------------------------------------------------
  // Names are unique in the app; two source rows with the same name become
  // one, and everything that pointed at either points at the survivor.
  const lookup = (table: string, idCol: string, nameCol: string, kind: string) => {
    const ids = new Map<string, string>();
    const byName = new Map<string, string>();
    const out: Row[] = [];
    for (const r of rows(table)) {
      const oldId = text(r, idCol);
      if (!oldId) {
        issues.add(`${table}: row without ${idCol} skipped`);
        continue;
      }
      const name = text(r, nameCol) ?? `Unnamed ${kind} ${oldId}`;
      const existing = byName.get(name.toLowerCase());
      if (existing) {
        ids.set(oldId, existing);
        issues.add(`${table}: duplicate name merged into the first one`, `#${oldId}`);
        continue;
      }
      const id = key(kind, oldId);
      ids.set(oldId, id);
      byName.set(name.toLowerCase(), id);
      out.push({ id, name });
    }
    return { ids, out };
  };
  const corpTypes = lookup("CORPORATION_TYPE", "CORP_TYPE_ID", "CORP_TYPE", "corptype");
  const businessTypes = lookup("BUSINESS_TYPE", "BUSINESS_TYPE_ID", "BUSINESS_TYPE", "businesstype");
  const employeeTypes = lookup("EMPLOYEE_TYPE", "EMPLOYEE_TYPE_ID", "EMPLOYEE_TYPE_NAME", "employeetype");

  // --- Cadences -------------------------------------------------------------------
  const periodDatesByRecurring = new Map<string, { start: Date; end: Date }[]>();
  for (const r of rows("ACCOUNTING_PERIOD")) {
    const rid = text(r, "RECURRING_ID");
    const s = parseSourceDate(r.PERIOD_START_DATE ?? null);
    const e = parseSourceDate(r.PERIOD_END_DATE ?? null);
    if (!rid || !(s instanceof Date) || !(e instanceof Date)) continue;
    const list = periodDatesByRecurring.get(rid) ?? [];
    list.push({ start: s, end: e });
    periodDatesByRecurring.set(rid, list);
  }

  const usedRecurring = new Set(
    [...rows("PROJECT"), ...rows("ACCOUNTING_PERIOD")].map((r) => text(r, "RECURRING_ID")).filter(Boolean)
  );
  const recurringType = new Map<string, RecurringType>();
  const recurringMapping: ImportReport["recurringMapping"] = [];
  for (const r of rows("PROJECT_RECURRING")) {
    const oldId = text(r, "RECURRING_ID");
    if (!oldId) continue;
    const code = text(r, "RECURRING_TYPE");
    const codeKey = code ? norm(code) : null;
    let type: RecurringType | null = null;
    let how = "";

    const byLength = (() => {
      const tally = new Map<RecurringType, number>();
      for (const p of periodDatesByRecurring.get(oldId) ?? []) {
        const t = cadenceFromLength(p.start, p.end);
        if (t) tally.set(t, (tally.get(t) ?? 0) + 1);
      }
      const best = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
      return best ? best[0] : null;
    })();

    const override = recurringOverrides[norm(oldId)] ?? (codeKey ? recurringOverrides[codeKey] : undefined);
    if (override) {
      type = override;
      how = "set with --recurring";
    } else if (codeKey && RECURRING_CODES[codeKey]) {
      type = RECURRING_CODES[codeKey];
      how = "from its code";
      if (byLength && byLength !== type) {
        issues.add(
          `PROJECT_RECURRING #${oldId}: code says ${type} but its periods look ${byLength}; used the code`
        );
      }
    } else if (byLength) {
      type = byLength;
      how = "from the length of its periods";
    } else {
      how = usedRecurring.has(oldId) ? "unknown" : "unknown, but nothing uses it";
    }
    if (type) recurringType.set(oldId, type);
    recurringMapping.push({ oldId, code, type, how });
  }

  // ProjectRecurring is one row per cadence in the app. All four exist so the
  // app never has to create one mid-request.
  const recurringId = (t: RecurringType) => `ktax-recurring-${t}`;
  const outRecurring: Row[] = RECURRING_TYPES.map((t) => ({ id: recurringId(t), type: t }));

  // --- Accounting periods -----------------------------------------------------------
  // Renamed into the app's own format ("2026-08", "2026-Q3", "2026",
  // "ONE-TIME") from their start dates, because the scheduler and rollover can
  // only step forward from names they can parse.
  type Period = { name: string; type: RecurringType; start: Date; end: Date };
  const periods = new Map<string, Period>(); // by new name
  const periodByOld = new Map<string, Period>(); // by source name
  const periodRenames: { from: string; to: string }[] = [];
  const unmappedPeriods = new Set<string>();

  for (const r of rows("ACCOUNTING_PERIOD")) {
    const oldName = text(r, "PERIOD_NAME");
    if (!oldName) {
      issues.add("ACCOUNTING_PERIOD: row without PERIOD_NAME skipped");
      continue;
    }
    const rid = text(r, "RECURRING_ID");
    const type = rid ? recurringType.get(rid) : undefined;
    if (!type) {
      unmappedPeriods.add(oldName);
      continue;
    }
    const start = date(r, "PERIOD_START_DATE", "ACCOUNTING_PERIOD", oldName);
    const end = date(r, "PERIOD_END_DATE", "ACCOUNTING_PERIOD", oldName);

    let name: string | null = null;
    if (type === "ONE_TIME") name = "ONE-TIME";
    else if (start) name = currentPeriodName(type, start);
    else if (periodNameFits(type, oldName)) name = oldName;
    if (!name) {
      unmappedPeriods.add(oldName);
      issues.add("ACCOUNTING_PERIOD: no start date and a name the app can't read; skipped", oldName);
      continue;
    }

    const canonical = type === "ONE_TIME" ? null : periodRangeForName(type, name);
    const periodStart = start ?? canonical?.start ?? now;
    const periodEnd = end ?? canonical?.end ?? periodStart;
    if (canonical && (!sameDay(periodStart, canonical.start) || !sameDay(periodEnd, canonical.end))) {
      issues.add(
        "ACCOUNTING_PERIOD: dates don't line up with a calendar month/quarter/year; kept the source dates",
        `${oldName} → ${name}`
      );
    }

    const existing = periods.get(name);
    if (existing) {
      if (existing.type !== type) {
        blockers.push(`Periods of two different cadences both became "${name}".`);
      }
      if (periodStart < existing.start) existing.start = periodStart;
      if (periodEnd > existing.end) existing.end = periodEnd;
      if (type !== "ONE_TIME") {
        issues.add("ACCOUNTING_PERIOD: two source periods became the same period and were merged", `${oldName} → ${name}`);
      }
      periodByOld.set(oldName, existing);
    } else {
      const p = { name, type, start: periodStart, end: periodEnd };
      periods.set(name, p);
      periodByOld.set(oldName, p);
    }
    if (oldName !== name) periodRenames.push({ from: oldName, to: name });
  }

  // A period referenced by work but missing from ACCOUNTING_PERIOD can still
  // be created when its name is already in the app's format.
  const ensurePeriod = (oldName: string, type: RecurringType): Period | null => {
    const known = periodByOld.get(oldName);
    if (known) return known;
    if (!periodNameFits(type, oldName)) return null;
    const existing = periods.get(oldName);
    if (existing) return existing;
    const range =
      type === "ONE_TIME" ? { start: now, end: now } : periodRangeForName(type, oldName);
    const p = { name: oldName, type, start: range.start, end: range.end };
    periods.set(oldName, p);
    periodByOld.set(oldName, p);
    return p;
  };

  // --- Projects, steps, checklists -------------------------------------------------------
  const settingsByName = new Map(ctx.projectSettings.map((p) => [p.name.trim().toLowerCase(), p]));
  const projectIds = new Map<string, string>();
  const projectInfo = new Map<string, { type: RecurringType; dueOffsetDays: number; name: string }>();
  const outProjects: Row[] = [];
  const projectNames = new Set<string>();
  for (const r of rows("PROJECT")) {
    const oldId = text(r, "PROJECT_ID");
    if (!oldId) continue;
    let name = text(r, "PROJECT_NAME") ?? `Unnamed project ${oldId}`;
    if (projectNames.has(name.toLowerCase())) {
      issues.add("PROJECT: duplicate name, renamed with its KTAX id", `#${oldId}`);
      name = `${name} (KTAX ${oldId})`;
    }
    projectNames.add(name.toLowerCase());
    const rid = text(r, "RECURRING_ID");
    const type = rid ? recurringType.get(rid) : undefined;
    if (!type) {
      blockers.push(
        `Project "${name}" (#${oldId}) has cadence #${rid ?? "none"}, which couldn't be mapped. ` +
          `See the cadence table above, then re-run with --recurring "${rid ?? "ID"}=MONTHLY|QUARTERLY|ANNUAL|ONE_TIME".`
      );
      continue;
    }
    const settings = settingsByName.get(name.toLowerCase());
    const dueOffsetDays = settings?.dueOffsetDays ?? 0;
    const id = key("project", oldId);
    projectIds.set(oldId, id);
    projectInfo.set(id, { type, dueOffsetDays, name });
    outProjects.push({
      id,
      name,
      description: text(r, "DESCRIPTION"),
      recurringId: recurringId(type),
      dueOffsetDays,
      ...stamps(r, "PROJECT", oldId),
    });
  }
  const carriedRules = outProjects.filter((p) => settingsByName.has(String(p.name).toLowerCase())).length;
  if (ctx.projectSettings.length) {
    notes.push(
      `${carriedRules} of ${outProjects.length} projects matched a project already set up in the app by name; ` +
        `their due-date rules and step estimates were kept.`
    );
  }

  const subtaskIds = new Map<string, string>();
  const subtaskNames = new Map<string, string>();
  const outSubtasks: Row[] = [];
  for (const r of rows("PROJECT_SUB_TASK")) {
    const oldId = text(r, "PROJECT_SUB_TASK_ID");
    if (!oldId) continue;
    const id = key("subtask", oldId);
    const name = text(r, "SUB_TASK_NAME") ?? `Unnamed step ${oldId}`;
    subtaskIds.set(oldId, id);
    subtaskNames.set(id, name);
    outSubtasks.push({
      id,
      name,
      note: cleanText(text(r, "SUB_TASK_NOTE"), "PROJECT_SUB_TASK", "SUB_TASK_NOTE", `#${oldId}`),
    });
  }

  const taskMaps = new Map<string, Row>(); // `${projectId}|${subTaskId}`
  for (const r of rows("PROJECT_TASK_MAP")) {
    const pOld = text(r, "PROJECT_ID");
    const sOld = text(r, "PROJECT_SUB_TASK_ID");
    const projectId = pOld ? projectIds.get(pOld) : undefined;
    const subTaskId = sOld ? subtaskIds.get(sOld) : undefined;
    const ref = `project #${pOld} step #${sOld}`;
    if (!projectId || !subTaskId) {
      issues.add("PROJECT_TASK_MAP: points at a project or step that doesn't exist; skipped", ref);
      continue;
    }
    const k = `${projectId}|${subTaskId}`;
    if (taskMaps.has(k)) {
      issues.add("PROJECT_TASK_MAP: same step listed twice on a project; kept the first", ref);
      continue;
    }
    const seq = Number(text(r, "TASK_SEQ_NO"));
    if (!Number.isFinite(seq)) issues.add("PROJECT_TASK_MAP: no sequence number; used 0", ref);
    const info = projectInfo.get(projectId)!;
    const step = settingsByName
      .get(info.name.toLowerCase())
      ?.steps.find((s) => s.name.trim().toLowerCase() === (subtaskNames.get(subTaskId) ?? "").toLowerCase());
    taskMaps.set(k, {
      projectId,
      subTaskId,
      sequence: Number.isFinite(seq) ? Math.trunc(seq) : 0,
      defaultAssigneeId: null,
      dueOffsetDays: step?.dueOffsetDays ?? null,
      estimatedMinutes: step?.estimatedMinutes ?? null,
    });
  }

  // --- Employees ----------------------------------------------------------------------
  // Everyone comes in invite-pending (no password): the old plain-text
  // passwords were never exported. Email is the login, so it has to be unique
  // and present; a placeholder stands in where it isn't.
  const employeeIds = new Map<string, string>();
  const outEmployees: Row[] = [];
  const adminByEmail = new Map(
    ctx.keepAdmins.map((a) => [String(a.email).toLowerCase(), { ...a, employeeTypeId: null } as Row])
  );
  const usedEmails = new Set<string>(adminByEmail.keys());
  const mergedAdmins = new Set<string>();
  const people: { id: string; email: string; first: string; last: string }[] = [];

  for (const r of rows("EMPLOYEES")) {
    const oldId = text(r, "EMPLOYEE_ID");
    if (!oldId) continue;
    const first = text(r, "FIRST_NAME") ?? "Unknown";
    const last = text(r, "LAST_NAME") ?? "";
    const typeOld = text(r, "EMPLOYEE_TYPE_ID");
    const employeeTypeId = typeOld ? employeeTypes.ids.get(typeOld) ?? null : null;
    let email = text(r, "EMAIL")?.toLowerCase() ?? null;

    const admin = email ? adminByEmail.get(email) : undefined;
    if (admin && email && !mergedAdmins.has(email)) {
      // The person running the import is also in KTAX: keep their login and
      // point their KTAX history at it.
      employeeIds.set(oldId, String(admin.id));
      admin.employeeTypeId = employeeTypeId;
      mergedAdmins.add(email);
      people.push({ id: String(admin.id), email, first: String(admin.firstName), last: String(admin.lastName) });
      continue;
    }

    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      issues.add("EMPLOYEES: no usable email; given a placeholder — set a real one before inviting them", `#${oldId}`);
      email = `employee-${oldId}@placeholder.invalid`;
    } else if (usedEmails.has(email)) {
      issues.add("EMPLOYEES: email already used by another employee; given a placeholder", `#${oldId}`);
      email = `employee-${oldId}@placeholder.invalid`;
    }
    usedEmails.add(email);
    const id = key("employee", oldId);
    employeeIds.set(oldId, id);
    people.push({ id, email, first, last });
    outEmployees.push({
      id,
      firstName: first,
      lastName: last,
      employeeTypeId,
      email,
      phone: text(r, "PHONE_NO"),
      mobile: text(r, "MOBILE_NO"),
      country: text(r, "COUNTRY"),
      role: "EMPLOYEE",
      passwordHash: null,
      ...stamps(r, "EMPLOYEES", oldId),
    });
  }
  // The admin rows go first so their ids exist before anything else does.
  outEmployees.unshift(...adminByEmail.values());
  if (ctx.keepAdmins.length === 0) {
    blockers.push(
      "The app has no admin account with a password, so nobody could sign in after the import. " +
        "Set up the app and sign in once as admin first (npm run db:seed), then import."
    );
  }

  // KTAX recorded who last touched a row as an APEX username, not an
  // employee id. It's matched to an employee only when the match is exact
  // (email, the part before the @, or "first last"); a guess would put
  // somebody's name on a sign-off they never made.
  const whoIndex = new Map<string, string | null>();
  const addWho = (k: string, id: string) => {
    const kk = k.trim().toLowerCase();
    if (!kk) return;
    whoIndex.set(kk, whoIndex.has(kk) && whoIndex.get(kk) !== id ? null : id);
  };
  for (const p of people) {
    addWho(p.email, p.id);
    addWho(p.email.split("@")[0], p.id);
    addWho(`${p.first} ${p.last}`, p.id);
    addWho(`${p.first}.${p.last}`, p.id);
    addWho(`${p.first}${p.last}`, p.id);
  }
  const who = (value: string | null) => (value ? whoIndex.get(value.trim().toLowerCase()) ?? null : null);

  // --- Clients and contacts -------------------------------------------------------------
  const clientIds = new Map<string, string>();
  const outClients: Row[] = [];
  const taxIdOwner = new Map<string, string>();
  const sortedClients = [...rows("CLIENT")].sort((a, b) => Number(a.CLIENT_ID) - Number(b.CLIENT_ID));
  for (const r of sortedClients) {
    const oldId = text(r, "CLIENT_ID");
    if (!oldId) continue;
    const id = key("client", oldId);
    clientIds.set(oldId, id);
    const ref = `#${oldId}`;

    let companyName = text(r, "COMPANY_NAME");
    if (!companyName) {
      issues.add("CLIENT: no company name; named after its KTAX id", ref);
      companyName = `Client ${oldId} (no name in KTAX)`;
    }
    const corpOld = text(r, "CORP_TYPE_ID");
    const bizOld = text(r, "BUSINESS_TYPE_ID");
    const corpTypeId = corpOld ? corpTypes.ids.get(corpOld) ?? null : null;
    const businessTypeId = bizOld ? businessTypes.ids.get(bizOld) ?? null : null;
    if (corpOld && !corpTypeId) issues.add("CLIENT: corporation type doesn't exist; left blank", ref);
    if (bizOld && !businessTypeId) issues.add("CLIENT: business type doesn't exist; left blank", ref);

    let note = cleanText(text(r, "NOTE"), "CLIENT", "NOTE", ref);
    // Tax id is unique in the app. Compared on digits so "12-3456789" and
    // "123456789" are recognised as the same EIN.
    let taxId = text(r, "FIN_NO");
    if (taxId) {
      if (/^\d{3}-\d{2}-\d{4}$/.test(taxId)) {
        issues.add("CLIENT.FIN_NO: tax id is in SSN format (a sole proprietor?) and is stored as typed — decide whether that's acceptable", ref);
      }
      const digits = taxId.replace(/\D/g, "");
      const k = digits.length >= 9 ? digits : taxId.toLowerCase();
      const owner = taxIdOwner.get(k);
      if (owner) {
        issues.add("CLIENT: FIN_NO already used by another client; moved into this client's note", `${ref} (same as #${owner})`);
        note = [`KTAX FIN_NO (duplicate of client #${owner}): ${taxId}`, note].filter(Boolean).join("\n");
        taxId = null;
      } else {
        taxIdOwner.set(k, oldId);
      }
    }

    outClients.push({
      id,
      companyName,
      corpTypeId,
      businessTypeId,
      address1: text(r, "ADDRESS1"),
      address2: text(r, "ADDRESS2"),
      city: text(r, "CITY"),
      zipcode: text(r, "ZIPCODE"),
      state: text(r, "STATE"),
      phone: text(r, "PHONE_NO"),
      fax: text(r, "FAX_NO"),
      taxId,
      note,
      coRegDate: date(r, "CO_REG_DATE", "CLIENT", ref),
      coRegState: text(r, "CO_REG_STATE"),
      renewMonth: text(r, "RENEW_MONTH"),
      email: text(r, "EMAIL_ADDRESS"),
      groupName: text(r, "GROUP_NAME"),
      ...stamps(r, "CLIENT", ref),
    });
  }

  const outContacts: Row[] = [];
  for (const r of rows("CORP_CONTACT")) {
    const oldId = text(r, "CORP_CONTACT_ID");
    if (!oldId) continue;
    const cOld = text(r, "CLIENT_ID");
    const clientId = cOld ? clientIds.get(cOld) : undefined;
    const ref = `#${oldId}`;
    if (!clientId) {
      issues.add("CORP_CONTACT: client doesn't exist; skipped", ref);
      continue;
    }
    outContacts.push({
      id: key("contact", oldId),
      clientId,
      firstName: text(r, "OWNER_FIRST_NAME"),
      lastName: text(r, "OWNER_LAST_NAME"),
      mobile: text(r, "MOBILE_NO"),
      email: text(r, "OWNER_EMAIL"),
      ssnEncrypted: null,
      note: cleanText(text(r, "NOTE"), "CORP_CONTACT", "NOTE", ref),
      ...stamps(r, "CORP_CONTACT", ref),
    });
  }

  // --- Engagements -----------------------------------------------------------------------
  const assignments = new Map<string, Row>(); // `${clientId}|${projectId}`
  for (const r of rows("PROJECT_CLIENT_MAP")) {
    const cOld = text(r, "CLIENT_ID");
    const pOld = text(r, "PROJECT_ID");
    const clientId = cOld ? clientIds.get(cOld) : undefined;
    const projectId = pOld ? projectIds.get(pOld) : undefined;
    const ref = `client #${cOld} project #${pOld}`;
    if (!clientId || !projectId) {
      issues.add("PROJECT_CLIENT_MAP: client or project doesn't exist; skipped", ref);
      continue;
    }
    const k = `${clientId}|${projectId}`;
    if (assignments.has(k)) {
      issues.add("PROJECT_CLIENT_MAP: same client and project listed twice; kept the first", ref);
      continue;
    }
    const type = projectInfo.get(projectId)!.type;

    const active = flag(text(r, "ACTIVE"));
    if (active === "unknown") issues.add("PROJECT_CLIENT_MAP.ACTIVE: unrecognised value; treated as active", ref);
    const createSubtask = flag(text(r, "CREATE_SUBTASK"));
    if (createSubtask === "unknown") issues.add("PROJECT_CLIENT_MAP.CREATE_SUBTASK: unrecognised value; treated as Y", ref);

    let currentPeriod: string | null = null;
    const cpOld = text(r, "CURRENT_PERIOD");
    if (cpOld) {
      const p = ensurePeriod(cpOld, type);
      if (!p) {
        issues.add("PROJECT_CLIENT_MAP.CURRENT_PERIOD: unknown period; left blank (the app starts it at today's period)", ref);
      } else if (p.type !== type) {
        issues.add("PROJECT_CLIENT_MAP.CURRENT_PERIOD: period is a different cadence from the project; left blank", ref);
      } else {
        currentPeriod = p.name;
      }
    }

    assignments.set(k, {
      clientId,
      projectId,
      active: active === false ? false : true,
      createSubtask: createSubtask === false ? false : true,
      startDate: date(r, "START_DATE", "PROJECT_CLIENT_MAP", ref),
      completedDate: date(r, "COMPLETED_DATE", "PROJECT_CLIENT_MAP", ref),
      currentPeriod,
      defaultAssigneeId: null,
      dueOffsetDays: null,
      note: cleanText(text(r, "NOTE"), "PROJECT_CLIENT_MAP", "NOTE", ref),
      ...stamps(r, "PROJECT_CLIENT_MAP", ref),
    });
  }

  // --- Work ---------------------------------------------------------------------------------
  const statusRows = new Map<string, { status: ActivityStatus | null; rows: number; how: "code" | "override" }>();
  const resolveStatus = (raw: string | null): ActivityStatus | null => {
    const k = raw === null ? "" : norm(raw);
    const override = statusOverrides[k];
    const status = override ?? (k === "" ? "NOT_STARTED" : STATUS_CODES[k] ?? null);
    const label = raw === null ? "(blank)" : raw.trim();
    const entry = statusRows.get(label) ?? { status, rows: 0, how: override ? "override" : "code" };
    entry.rows += 1;
    statusRows.set(label, entry);
    return status;
  };

  type Candidate = { row: Row; stamp: number; oldId: number };
  const activities = new Map<string, Candidate>();
  let completedMatched = 0;
  let completedTotal = 0;
  for (const r of rows("CLIENT_ACTIVITY")) {
    const oldId = text(r, "ACTIVITY_ID");
    if (!oldId) continue;
    const ref = `#${oldId}`;
    const status = resolveStatus(text(r, "STATUS"));

    const cOld = text(r, "CLIENT_ID");
    const pOld = text(r, "PROJECT_ID");
    const sOld = text(r, "SUB_TASK_ID");
    const clientId = cOld ? clientIds.get(cOld) : undefined;
    const projectId = pOld ? projectIds.get(pOld) : undefined;
    const subTaskId = sOld ? subtaskIds.get(sOld) : undefined;
    if (!clientId || !projectId || !subTaskId) {
      issues.add("CLIENT_ACTIVITY: client, project or step doesn't exist; skipped", ref);
      continue;
    }
    const info = projectInfo.get(projectId)!;
    const pName = text(r, "PERIOD_NAME");
    const period = pName ? ensurePeriod(pName, info.type) : null;
    if (!period) {
      issues.add("CLIENT_ACTIVITY: period doesn't exist and its name can't be read; skipped", ref);
      continue;
    }
    if (period.type !== info.type) {
      issues.add("CLIENT_ACTIVITY: period cadence differs from the project's; kept", ref);
    }
    if (!status) continue; // counted in the status table; a blocker below

    const map = taskMaps.get(`${projectId}|${subTaskId}`);
    const seqRaw = Number(text(r, "TASK_SEQ_NO"));
    const taskSeqNo = Number.isFinite(seqRaw) ? Math.trunc(seqRaw) : Number(map?.sequence ?? 0);
    const assignment = assignments.get(`${clientId}|${projectId}`);
    const due = resolveStepDueDates({
      periodEnd: period.end,
      projectOffset: info.dueOffsetDays,
      clientOverride: (assignment?.dueOffsetDays as number | null | undefined) ?? null,
      steps: [{ subTaskId, dueOffsetDays: (map?.dueOffsetDays as number | null | undefined) ?? null }],
    }).get(subTaskId)!;

    const { createdAt, updatedAt } = stamps(r, "CLIENT_ACTIVITY", ref);
    let completedAt: Date | null = null;
    let completedById: string | null = null;
    if (status === "DONE") {
      completedAt = updatedAt;
      completedById = who(text(r, "LAST_UPDATED_BY"));
      completedTotal += 1;
      if (completedById) completedMatched += 1;
    }

    const row: Row = {
      id: key("activity", oldId),
      clientId,
      projectId,
      subTaskId,
      periodName: period.name,
      status,
      taskSeqNo,
      dueDate: due,
      dueDateOverridden: false,
      completedAt,
      completedById,
      estimatedMinutes: (map?.estimatedMinutes as number | null | undefined) ?? null,
      notes: cleanText(text(r, "NOTES"), "CLIENT_ACTIVITY", "NOTES", ref),
      assigneeId: null,
      createdAt,
      updatedAt,
    };

    // One row per client/project/step/period in the app. When KTAX has two,
    // the most recently edited one is the one people were looking at.
    const k = `${clientId}|${projectId}|${subTaskId}|${period.name}`;
    const candidate = { row, stamp: updatedAt.getTime(), oldId: Number(oldId) };
    const existing = activities.get(k);
    if (existing) {
      issues.add(
        "CLIENT_ACTIVITY: same step twice for one client, project and period; kept the most recently edited",
        `#${Math.min(existing.oldId, candidate.oldId)} / #${Math.max(existing.oldId, candidate.oldId)}`
      );
      if (candidate.stamp > existing.stamp || (candidate.stamp === existing.stamp && candidate.oldId > existing.oldId)) {
        activities.set(k, candidate);
      }
    } else {
      activities.set(k, candidate);
    }
  }

  const statusMapping: ImportReport["statusMapping"] = [];
  for (const [value, entry] of statusRows) {
    if (!entry.status) {
      blockers.push(
        `${entry.rows} task rows have status "${value}", which has no obvious meaning. ` +
          `Re-run with --status "${value}=NOT_STARTED|IN_PROGRESS|AWAITING_REVIEW|DONE".`
      );
    } else {
      statusMapping.push({ value, status: entry.status, rows: entry.rows, how: entry.how });
    }
  }
  statusMapping.sort((a, b) => b.rows - a.rows);

  if (completedTotal) {
    notes.push(
      `${completedMatched} of ${completedTotal} completed tasks were matched to the employee who completed them ` +
        `(KTAX's LAST_UPDATED_BY); the rest show as completed by nobody in particular.`
    );
  }

  if (unmappedPeriods.size) {
    const used = rows("CLIENT_ACTIVITY").some((r) => unmappedPeriods.has(text(r, "PERIOD_NAME") ?? ""));
    const msg = `${unmappedPeriods.size} accounting periods belong to a cadence that couldn't be mapped`;
    if (used) blockers.push(`${msg}, and tasks use them. Map the cadence with --recurring.`);
    else issues.add(`${msg}; nothing uses them, so they were left out`);
  }

  if (ssnsRemoved) {
    notes.push(`${ssnsRemoved} SSN-shaped numbers were removed from notes. The originals are still in KTAX and the export zip.`);
  }

  const taxExtensions = source.CLIENT_TAX_EXTENSION?.length ?? 0;
  if (taxExtensions) {
    notes.push(
      `CLIENT_TAX_EXTENSION (${taxExtensions} row${taxExtensions === 1 ? "" : "s"}) was not imported — the app has no tax extension records yet. Keep the export zip until it does.`
    );
  }

  // --- What the scheduler will do next ------------------------------------------------------
  // Mirrors generatePeriods in src/lib/scheduler.ts: every active engagement
  // is walked from its current period up to today's, and every period on
  // that walk (the current one included) gets whichever checklist steps it
  // doesn't have yet, as Not Started rows. An engagement more than 60
  // periods behind is left alone.
  const stepsPerProject = new Map<string, string[]>();
  for (const tm of taskMaps.values()) {
    const p = String(tm.projectId);
    stepsPerProject.set(p, [...(stepsPerProject.get(p) ?? []), String(tm.subTaskId)]);
  }
  const catchUp = { engagements: 0, periods: 0, rows: 0, tooFarBehind: 0 };
  for (const a of assignments.values()) {
    if (!a.active) continue;
    const clientId = String(a.clientId);
    const projectId = String(a.projectId);
    const info = projectInfo.get(projectId)!;
    const steps = stepsPerProject.get(projectId) ?? [];
    if (info.type === "ONE_TIME" || steps.length === 0) continue;
    const target = currentPeriodName(info.type, now);
    let cursor = (a.currentPeriod as string | null) ?? target;
    const walk = [cursor];
    let guard = 0;
    while (isPeriodBefore(info.type, cursor, target)) {
      if (guard++ >= 60) break;
      const next = nextPeriodName(info.type, cursor);
      if (!next) break;
      cursor = next;
      walk.push(cursor);
    }
    if (guard >= 60) {
      catchUp.tooFarBehind += 1;
      continue;
    }
    let missing = 0;
    for (const period of walk) {
      for (const subTaskId of steps) {
        if (!activities.has(`${clientId}|${projectId}|${subTaskId}|${period}`)) missing += 1;
      }
    }
    if (missing > 0) {
      catchUp.engagements += 1;
      catchUp.periods += walk.length - 1;
      catchUp.rows += missing;
    }
  }

  // --- Assemble -------------------------------------------------------------------------------
  const tables = Object.fromEntries(BACKUP_TABLES.map((t) => [t, [] as Row[]])) as Record<BackupTable, Row[]>;
  tables.CorporationType = corpTypes.out;
  tables.BusinessType = businessTypes.out;
  tables.EmployeeType = employeeTypes.out;
  tables.ProjectRecurring = outRecurring;
  tables.AccountingPeriod = [...periods.values()].map((p) => ({
    name: p.name,
    startDate: p.start,
    endDate: p.end,
    recurringId: recurringId(p.type),
  }));
  tables.Employee = outEmployees;
  tables.Client = outClients;
  tables.CorpContact = outContacts;
  tables.Project = outProjects;
  tables.ProjectSubTask = outSubtasks;
  tables.ProjectTaskMap = [...taskMaps.values()];
  tables.ProjectClientMap = [...assignments.values()];
  tables.ClientActivity = [...activities.values()].map((c) => c.row);
  tables.EmailTemplate = ctx.keepEmailTemplates;
  tables.AuditEvent = [
    {
      id: `ktax-import-${now.getTime()}`,
      entityType: "Import",
      entityId: "ktax",
      action: "data.imported",
      actorId: null,
      actorLabel: "KTAX import",
      summary:
        `Imported ${outClients.length} clients, ${tables.ClientActivity.length} tasks and ` +
        `${outEmployees.length - ctx.keepAdmins.length} employees from KTAX`,
      createdAt: now,
    },
  ];

  const imported: Record<string, number> = {
    ACCOUNTING_PERIOD: periodByOld.size,
    BUSINESS_TYPE: rows("BUSINESS_TYPE").length - issuesFor(issues, "BUSINESS_TYPE: row without"),
    CLIENT: outClients.length,
    CLIENT_ACTIVITY: tables.ClientActivity.length,
    CLIENT_TAX_EXTENSION: 0,
    CORPORATION_TYPE: rows("CORPORATION_TYPE").length - issuesFor(issues, "CORPORATION_TYPE: row without"),
    CORP_CONTACT: outContacts.length,
    EMPLOYEES: employeeIds.size,
    EMPLOYEE_TYPE: rows("EMPLOYEE_TYPE").length - issuesFor(issues, "EMPLOYEE_TYPE: row without"),
    PROJECT: outProjects.length,
    PROJECT_CLIENT_MAP: assignments.size,
    PROJECT_RECURRING: recurringType.size,
    PROJECT_SUB_TASK: outSubtasks.length,
    PROJECT_TASK_MAP: taskMaps.size,
  };

  return {
    tables,
    report: {
      blockers,
      warnings: issues.list(),
      notes,
      source: KTAX_TABLES.map((t) => ({
        table: t,
        read: source[t]?.length ?? 0,
        expected: expected.get(t) ?? null,
        imported: imported[t] ?? null,
      })),
      statusMapping,
      recurringMapping,
      periodRenames,
      catchUp,
    },
  };
}

function issuesFor(issues: Issues, prefix: string): number {
  return issues
    .list()
    .filter((i) => i.message.startsWith(prefix))
    .reduce((n, i) => n + i.count, 0);
}
