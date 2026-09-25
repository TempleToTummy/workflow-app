// The KTAX import transform: CSV parsing, value mapping, and every rule that
// decides what is imported, merged, skipped or refused. No database:
//
//   ./node_modules/.bin/tsx scripts/test-ktax-import.ts
import { deflateRawSync } from "node:zlib";
import {
  parseCsv,
  parseSourceDate,
  parseStatusArgs,
  parseRecurringArgs,
  periodNameFits,
  redactSsns,
  transformKtax,
  type ImportContext,
  type SourceTables,
} from "../src/lib/ktax-import";
import { readZip } from "../src/lib/zip-read";
import { check, checkThrows, section, finish } from "./harness";

section("parseCsv");
{
  const rows = parseCsv('﻿A,"B",C\r\n1,"x, ""y""",\r\n2,"line1\nline2",z\r\n');
  check("BOM stripped, header read", Object.keys(rows[0]), ["A", "B", "C"]);
  check("quoted comma and doubled quotes", rows[0].B, 'x, "y"');
  check("empty field is null", rows[0].C, null);
  check("newline inside quotes", rows[1].B, "line1\nline2");
  check("no trailing newline still reads the last row", parseCsv("A\n1").length, 1);
  check("header only = no rows", parseCsv("A,B\r\n").length, 0);
  checkThrows("wrong field count is refused", () => parseCsv("A,B\n1,2,3\n"), "row 2 has 3 fields but the header has 2");
  checkThrows("unterminated quote is refused", () => parseCsv('A\n"abc\n'));
}

section("parseSourceDate");
{
  const d = parseSourceDate("2024-03-31T00:00:00") as Date;
  check("local midnight, not UTC", [d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()], [2024, 2, 31, 0]);
  check("date only", (parseSourceDate("2024-02-29") as Date).getDate(), 29);
  check("blank", parseSourceDate(null), null);
  check("impossible date", parseSourceDate("2023-02-29T00:00:00"), "invalid");
  check("other format", parseSourceDate("31-MAR-24"), "invalid");
}

section("mapping arguments");
{
  check("status pair, normalised both sides", parseStatusArgs(["on hold=in progress"]), { "ON HOLD": "IN_PROGRESS" });
  check("recurring pair", parseRecurringArgs(["7=monthly"]), { "7": "MONTHLY" });
  checkThrows("unknown target refused", () => parseStatusArgs(["X=FINISHED"]));
  checkThrows("missing = refused", () => parseRecurringArgs(["MONTHLY"]));
}

section("periodNameFits");
{
  check("monthly", [periodNameFits("MONTHLY", "2026-08"), periodNameFits("MONTHLY", "2026-13"), periodNameFits("MONTHLY", "AUG-2026")], [true, false, false]);
  check("quarterly", [periodNameFits("QUARTERLY", "2026-Q3"), periodNameFits("QUARTERLY", "2026-Q5")], [true, false]);
  check("annual / one-time", [periodNameFits("ANNUAL", "2026"), periodNameFits("ONE_TIME", "ONE-TIME")], [true, true]);
}

section("redactSsns");
{
  check("dashed", redactSsns("owner 123-45-6789 ok"), { text: "owner [SSN removed] ok", removed: 1 });
  check("spaced", redactSsns("123 45 6789").removed, 1);
  check("EIN untouched", redactSsns("EIN 12-3456789").removed, 0);
  check("phone untouched", redactSsns("call 555-123-4567").removed, 0);
}

section("readZip");
{
  // A two-entry zip, one stored and one deflated, built by hand.
  const entry = (name: string, data: Buffer, method: 0 | 8) => {
    const body = method === 8 ? deflateRawSync(data) : data;
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    return { name: nameBuf, local: Buffer.concat([local, nameBuf, body]), body, method, size: data.length };
  };
  const a = entry("A.csv", Buffer.from("X\n1\n"), 0);
  const b = entry("dir/B.csv", Buffer.from("Y\n2\n".repeat(50)), 8);
  let offset = 0;
  const central: Buffer[] = [];
  for (const e of [a, b]) {
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(e.method, 10);
    c.writeUInt32LE(e.body.length, 20);
    c.writeUInt32LE(e.size, 24);
    c.writeUInt16LE(e.name.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([c, e.name]));
    offset += e.local.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(2, 8);
  end.writeUInt16LE(2, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  const zip = readZip(Buffer.concat([a.local, b.local, cd, end]));
  check("entries", [...zip.keys()], ["A.csv", "dir/B.csv"]);
  check("stored entry", zip.get("A.csv")!.toString(), "X\n1\n");
  check("deflated entry", zip.get("dir/B.csv")!.toString().length, 200);
  checkThrows("not a zip", () => readZip(Buffer.from("hello, this is plainly not a zip file")));
}

// --- The transform ----------------------------------------------------------------

const admin = { id: "admin-1", email: "boss@firm.test", firstName: "Pat", lastName: "Boss", role: "ADMIN", passwordHash: "s:h", employeeTypeId: "old-type" };

function ctx(over: Partial<ImportContext> = {}): ImportContext {
  return {
    keepAdmins: [admin],
    keepEmailTemplates: [{ id: "t1", key: "doc-request" }],
    projectSettings: [
      { name: "Bookkeeping", dueOffsetDays: 15, steps: [{ name: "Data entry", dueOffsetDays: -5, estimatedMinutes: 90 }] },
    ],
    now: new Date(2026, 8, 25),
    ...over,
  };
}

// A small but complete KTAX export.
function source(): SourceTables {
  const t = (header: string, ...lines: string[]) => parseCsv([header, ...lines].join("\n"));
  return {
    PROJECT_RECURRING: t("RECURRING_ID,RECURRING_TYPE", "1,M   ", "2,Q", "3,Y", "4,Z", "5,X", "6,W"),
    ACCOUNTING_PERIOD: t(
      "PERIOD_NAME,PERIOD_START_DATE,PERIOD_END_DATE,RECURRING_ID",
      "AUG-2026,2026-08-01T00:00:00,2026-08-31T00:00:00,1",
      "SEP-2026,2026-09-01T00:00:00,2026-09-30T00:00:00,1",
      "Q2-2026,2026-04-01T00:00:00,2026-06-30T00:00:00,2",
      "FY2025,2025-01-01T00:00:00,2025-12-31T00:00:00,3",
      "Z1,2026-01-01T00:00:00,2026-01-31T00:00:00,4",
      "X1,2026-01-01T00:00:00,2026-01-10T00:00:00,5"
    ),
    CORPORATION_TYPE: t("CORP_TYPE_ID,CORP_TYPE", "1,LLC", "2,llc", "3,S-Corp"),
    BUSINESS_TYPE: t("BUSINESS_TYPE_ID,BUSINESS_TYPE", "1,Restaurant"),
    EMPLOYEE_TYPE: t("EMPLOYEE_TYPE_ID,EMPLOYEE_TYPE_NAME", "1,Accountant"),
    EMPLOYEES: t(
      "EMPLOYEE_ID,FIRST_NAME,LAST_NAME,EMPLOYEE_TYPE_ID,EMAIL",
      "10,Pat,Boss,1,BOSS@firm.test",
      "11,Ann,Lee,1,ann@firm.test",
      "12,Bo,Kim,1,",
      "13,Cy,Doe,1,ann@firm.test"
    ),
    PROJECT: t("PROJECT_ID,PROJECT_NAME,DESCRIPTION,RECURRING_ID", "1,Bookkeeping,Books,1", "2,Sales Tax,,2", "3,Annual Report,,3"),
    PROJECT_SUB_TASK: t("PROJECT_SUB_TASK_ID,SUB_TASK_NAME,SUB_TASK_NOTE", "1,Document Received,", "2,Data entry,", "3,File,"),
    PROJECT_TASK_MAP: t(
      "PROJECT_ID,PROJECT_SUB_TASK_ID,TASK_SEQ_NO",
      "1,1,10",
      "1,2,20",
      "1,2,30",
      "2,3,10",
      "9,1,10"
    ),
    CLIENT: t(
      "CLIENT_ID,COMPANY_NAME,CORP_TYPE_ID,BUSINESS_TYPE_ID,FIN_NO,NOTE,EMAIL_ADDRESS,CO_REG_DATE",
      '2,"Acme, Inc.",2,1,12-3456789,"owner ssn 123-45-6789",a@acme.test,2020-01-15T00:00:00',
      "1,Beta LLC,1,,123456789,,,",
      "3,,99,,111-22-3333,,,bad-date"
    ),
    CORP_CONTACT: t("CORP_CONTACT_ID,CLIENT_ID,OWNER_FIRST_NAME,NOTE", "1,1,Jo,", "2,42,Ghost,"),
    PROJECT_CLIENT_MAP: t(
      "CLIENT_ID,PROJECT_ID,ACTIVE,CREATE_SUBTASK,CURRENT_PERIOD",
      "1,1,Y,Y,AUG-2026",
      "2,1,N,Y,SEP-2026",
      "1,1,Y,Y,AUG-2026",
      "3,2,?,Y,Q2-2026",
      "2,2,Y,Y,nonsense"
    ),
    CLIENT_ACTIVITY: t(
      "ACTIVITY_ID,CLIENT_ID,PERIOD_NAME,PROJECT_ID,SUB_TASK_ID,STATUS,TASK_SEQ_NO,NOTES,LAST_UPDATED_BY,LAST_UPDATE_DATE",
      "100,1,AUG-2026,1,1,Y,10,,ANN,2026-08-10T09:00:00",
      "101,1,AUG-2026,1,2,In Progress,20,,,2026-08-11T09:00:00",
      "102,1,AUG-2026,1,2,Y,20,,boss@firm.test,2026-08-12T09:00:00",
      "103,1,2026-09,1,1,,10,,,",
      "104,1,NOPE,1,1,N,10,,,",
      "105,77,AUG-2026,1,1,N,10,,,",
      "106,3,Q2-2026,2,3,Completed,10,,someone,2026-07-01T00:00:00"
    ),
    CLIENT_TAX_EXTENSION: t("EXTENSION_ID,CLIENT_ID", "1,1"),
  };
}

const withCounts = (s: SourceTables): SourceTables => ({
  ...s,
  _ROW_COUNTS: Object.entries(s).map(([k, v]) => ({ TABLE_NAME: k, ROW_COUNT: String(v.length) })),
});

section("transform: completeness and refusals");
{
  const s = withCounts(source());
  const good = transformKtax(s, ctx());
  check("a clean export has no blockers", good.report.blockers, []);

  const short = { ...s, CLIENT: s.CLIENT.slice(1) };
  check(
    "a short file is refused",
    transformKtax(short, ctx()).report.blockers.some((b) => b.startsWith("CLIENT.csv has 2 rows but the export counted 3")),
    true
  );

  const missing = withCounts(source());
  delete missing.PROJECT;
  check("a missing table is refused", transformKtax(missing, ctx()).report.blockers.includes("PROJECT.csv is missing from the export."), true);

  const leaked = withCounts(source());
  leaked.CORP_CONTACT = leaked.CORP_CONTACT.map((r) => ({ ...r, OWNER_SSN_NO: "123-45-6789" }));
  check(
    "an exported SSN column is refused",
    transformKtax(leaked, ctx()).report.blockers.some((b) => b.includes("OWNER_SSN_NO")),
    true
  );

  check(
    "no admin to sign in with is refused",
    transformKtax(s, ctx({ keepAdmins: [] })).report.blockers.some((b) => b.includes("no admin account")),
    true
  );

  const unknownStatus = withCounts(source());
  unknownStatus.CLIENT_ACTIVITY = [...unknownStatus.CLIENT_ACTIVITY, { ...unknownStatus.CLIENT_ACTIVITY[0], ACTIVITY_ID: "200", STATUS: "P" }];
  const r = transformKtax({ ...unknownStatus, _ROW_COUNTS: undefined as never }, ctx());
  check("an unknown status is a blocker naming it", r.report.blockers.some((b) => b.includes('status "P"')), true);
  const fixed = transformKtax({ ...unknownStatus, _ROW_COUNTS: undefined as never }, ctx({ statusOverrides: parseStatusArgs(["P=IN_PROGRESS"]) }));
  check("...and --status resolves it", fixed.report.blockers, []);
}

section("transform: cadences and periods");
{
  const { tables, report } = transformKtax(withCounts(source()), ctx());
  const how = Object.fromEntries(report.recurringMapping.map((m) => [m.oldId, `${m.type}:${m.how}`]));
  check("code M (space-padded CHAR)", how["1"], "MONTHLY:from its code");
  check("code Y is annual", how["3"], "ANNUAL:from its code");
  check("unknown code inferred from period length", how["4"], "MONTHLY:from the length of its periods");
  check("unknown code with odd periods stays unmapped", how["5"], "null:unknown");
  check("unused unknown code says so", how["6"], "null:unknown, but nothing uses it");
  check("all four cadences exist", tables.ProjectRecurring.map((r) => r.type), ["MONTHLY", "QUARTERLY", "ANNUAL", "ONE_TIME"]);

  const names = tables.AccountingPeriod.map((p) => p.name).sort();
  check("periods renamed to the app's format", names, ["2025", "2026-01", "2026-08", "2026-09", "2026-Q2"]);
  check("rename listed", report.periodRenames.find((p) => p.from === "Q2-2026")?.to, "2026-Q2");
  check(
    "unused unmapped cadence is a warning, not a blocker",
    report.warnings.some((w) => w.message.startsWith("1 accounting periods belong to a cadence")),
    true
  );
}

section("transform: lookups, employees, clients");
{
  const { tables, report } = transformKtax(withCounts(source()), ctx());
  check("duplicate lookup names merged", tables.CorporationType.map((c) => c.name), ["LLC", "S-Corp"]);
  const client = (id: string) => tables.Client.find((c) => c.id === `ktax-client-${id}`)!;
  check("client pointing at the merged duplicate follows it", client("2").corpTypeId, "ktax-corptype-1");
  check("missing lookup left blank", client("3").corpTypeId, null);
  check("no company name gets a placeholder", client("3").companyName, "Client 3 (no name in KTAX)");
  check("unreadable date blank", client("3").coRegDate, null);
  check("SSN in a note removed", String(client("2").note).endsWith("\nowner ssn [SSN removed]"), true);
  check("comma in a name survives", client("2").companyName, "Acme, Inc.");

  // Clients are processed in id order, so #1 keeps the EIN and #2 (same
  // digits, different punctuation) has it moved into its note.
  check("first EIN kept", client("1").taxId, "123456789");
  check("duplicate EIN cleared", client("2").taxId, null);
  check("duplicate EIN preserved in the note", String(client("2").note).startsWith("KTAX FIN_NO (duplicate of client #1): 12-3456789"), true);
  check("SSN-format tax id flagged by id", report.warnings.find((w) => w.message.startsWith("CLIENT.FIN_NO"))?.examples, ["#3"]);

  const emails = tables.Employee.map((e) => e.email);
  check("admin kept, KTAX twin merged into it", emails.filter((e) => e === "boss@firm.test").length, 1);
  check("kept admin's stale type cleared, KTAX type applied", tables.Employee[0].employeeTypeId, "ktax-employeetype-1");
  check("emails lowercased", emails.includes("ann@firm.test"), true);
  check("missing email → placeholder", emails.includes("employee-12@placeholder.invalid"), true);
  check("duplicate email → placeholder", emails.includes("employee-13@placeholder.invalid"), true);
  check("imported employees can't sign in yet", tables.Employee.filter((e) => e.id !== "admin-1").every((e) => e.passwordHash === null && e.role === "EMPLOYEE"), true);

  check("orphan contact skipped", tables.CorpContact.map((c) => c.id), ["ktax-contact-1"]);
  check("no SSN in any contact", tables.CorpContact.every((c) => c.ssnEncrypted === null), true);
}

section("transform: projects, checklists, engagements");
{
  const { tables } = transformKtax(withCounts(source()), ctx());
  const bk = tables.Project.find((p) => p.name === "Bookkeeping")!;
  check("due rule carried over by name", bk.dueOffsetDays, 15);
  check("unmatched project defaults to 0", tables.Project.find((p) => p.name === "Sales Tax")!.dueOffsetDays, 0);
  check("duplicate step on a checklist kept once, orphan skipped", tables.ProjectTaskMap.length, 3);
  const entry = tables.ProjectTaskMap.find((m) => m.subTaskId === "ktax-subtask-2")!;
  check("step estimate and offset carried by name", [entry.estimatedMinutes, entry.dueOffsetDays, entry.sequence], [90, -5, 20]);

  const map = (c: string, p: string) => tables.ProjectClientMap.find((m) => m.clientId === `ktax-client-${c}` && m.projectId === `ktax-project-${p}`);
  check("duplicate engagement kept once", tables.ProjectClientMap.length, 4);
  check("current period renamed", map("1", "1")!.currentPeriod, "2026-08");
  check("inactive kept inactive", map("2", "1")!.active, false);
  check("unknown flag → active", map("3", "2")!.active, true);
  check("unreadable current period → blank", map("2", "2")!.currentPeriod, null);
}

section("transform: tasks");
{
  const { tables, report } = transformKtax(withCounts(source()), ctx());
  const a = (id: string) => tables.ClientActivity.find((x) => x.id === `ktax-activity-${id}`);
  check("duplicate step: most recently edited wins", [a("101"), a("102")?.status], [undefined, "DONE"]);
  check("status Y → DONE, blank → NOT_STARTED, Completed → DONE", [a("100")!.status, a("103")!.status, a("106")!.status], ["DONE", "NOT_STARTED", "DONE"]);
  check("already-app-format period accepted", a("103")!.periodName, "2026-09");
  check("unreadable period skipped", a("104"), undefined);
  check("orphan client skipped", a("105"), undefined);
  check("completedBy matched by email local part", a("100")!.completedById, "ktax-employee-11");
  check("completedBy matched by email → the kept admin", a("102")!.completedById, "admin-1");
  check("unknown user left blank", a("106")!.completedById, null);
  check("completedAt from last update", (a("100")!.completedAt as Date).getDate(), 10);

  // Bookkeeping due 15 days after Aug 31 = Sep 15; the Data entry step is 5 days earlier.
  const due = (x: Record<string, unknown>) => (x.dueDate as Date).toDateString();
  check("due date from carried rules", due(a("100")!), new Date(2026, 8, 15).toDateString());
  check("step offset applied", due(a("102")!), new Date(2026, 8, 10).toDateString());

  const mapping = report.statusMapping.map((s) => `${s.value}=${s.status}`).sort();
  check("status table reported", mapping, ["(blank)=NOT_STARTED", "Completed=DONE", "In Progress=IN_PROGRESS", "N=NOT_STARTED", "Y=DONE"]);
  check("tax extensions reported, not imported", report.notes.some((n) => n.startsWith("CLIENT_TAX_EXTENSION (1 row)")), true);
  check("kept email templates", tables.EmailTemplate.length, 1);
  check("one audit entry for the import", tables.AuditEvent.length, 1);
}

section("transform: catch-up estimate");
{
  // Today is Sep 2026. Client 1 bookkeeping is parked at 2026-08 with both
  // steps there, and one of two steps already in 2026-09 (activity 103):
  // one more row. Client 2's is inactive. Client 3's quarterly engagement
  // sits at 2026-Q2 with its one step done, so 2026-Q3 needs one row. Client
  // 2's sales tax has no current period, so it starts at 2026-Q3: one row.
  const { report } = transformKtax(withCounts(source()), ctx());
  const { breakdown, ...totals } = report.catchUp;
  check("rows the scheduler will create", totals, { engagements: 3, periods: 2, rows: 3, tooFarBehind: 0 });
  // Client 1's current 2026-08 is complete; 2026-09 is a new period missing
  // one step. Client 3's 2026-Q3 is a new period. Client 2's sales tax has no
  // current period, so today's period is its current one, and it's empty.
  check("breakdown: new periods", breakdown.newPeriods, 2);
  check("breakdown: empty current period", breakdown.currentPeriodEmpty, { engagements: 1, rows: 1 });
  check("breakdown: gaps in the current period", breakdown.currentPeriodGaps, { engagements: 0, rows: 0 });
  check("breakdown: no current period in KTAX", breakdown.noCurrentPeriod, { engagements: 1, rows: 1 });
  check("breakdown: by project", breakdown.byProject.map((p) => [p.project, p.rows]), [["Sales Tax", 2], ["Bookkeeping", 1]]);

  const off = withCounts(source());
  off.PROJECT_CLIENT_MAP = off.PROJECT_CLIENT_MAP.map((r) => (r.CURRENT_PERIOD === "AUG-2026" ? { ...r, CREATE_SUBTASK: "N" } : r));
  check("breakdown: CREATE_SUBTASK = N counted", transformKtax(off, ctx()).report.catchUp.breakdown.createSubtaskOff, { engagements: 1, rows: 1 });

  const old = withCounts(source());
  old.PROJECT_CLIENT_MAP = old.PROJECT_CLIENT_MAP.map((r) => (r.CURRENT_PERIOD === "AUG-2026" ? { ...r, CURRENT_PERIOD: "2016-01" } : r));
  check("more than 60 periods behind is left alone", transformKtax(old, ctx()).report.catchUp.tooFarBehind, 1);
}

finish();
