// Production first run. scripts/prepare-deploy.ts runs this on every start
// when NODE_ENV=production, instead of the demo seed (prisma/seed.ts), which
// wipes the database and creates a known admin password and sample clients.
//
// Idempotent and non-destructive. It:
//   1. loads the reference data a fresh installation needs — corporation
//      types and the firm's service catalog — only into an empty database,
//   2. adds any built-in email template that's missing (existing ones, and
//      any edits to them, are left alone),
//   3. makes sure the firm's first admin can get in: until some admin has a
//      password, it (re)issues an invite for FIRST_ADMIN_EMAIL and prints the
//      /invite/<token> link to the server log. Whoever can read the log on
//      the server opens the link and sets the password; nothing is guessable
//      and no password is ever printed or stored in plain text.
//
//   FIRST_ADMIN_EMAIL="owner@yourfirm.com" FIRST_ADMIN_NAME="Pat Lee" npx tsx prisma/setup.ts
import { PrismaClient, type RecurringType } from "@prisma/client";
import { newToken, inviteExpiry, INVITE_TTL_MS } from "../src/lib/password";
import { BUILT_IN_TEMPLATES } from "./email-templates";
import { CORPORATION_TYPES, DUE_RULES, PROJECT_CATALOG } from "./catalog";

const prisma = new PrismaClient();

async function loadReferenceData() {
  const [employees, projects] = await Promise.all([prisma.employee.count(), prisma.project.count()]);
  if (employees > 0 || projects > 0) return;

  for (const name of CORPORATION_TYPES) {
    await prisma.corporationType.upsert({ where: { name }, create: { name }, update: {} });
  }

  for (const def of PROJECT_CATALOG) {
    const recurring = await prisma.projectRecurring.upsert({
      where: { type: def.recurring as RecurringType },
      create: { type: def.recurring as RecurringType },
      update: {},
    });
    const project = await prisma.project.create({
      data: {
        name: def.name,
        description: def.description,
        recurringId: recurring.id,
        dueOffsetDays: DUE_RULES[def.name] ?? 0,
      },
    });
    const ordered = [...def.steps].sort((a, b) => a.seq - b.seq);
    for (const [i, step] of ordered.entries()) {
      const subTask = await prisma.projectSubTask.create({ data: { name: step.name } });
      await prisma.projectTaskMap.create({
        data: { projectId: project.id, subTaskId: subTask.id, sequence: i + 1 },
      });
    }
  }
  console.log(`[setup] Loaded ${CORPORATION_TYPES.length} corporation types and ${PROJECT_CATALOG.length} services.`);
}

async function loadEmailTemplates() {
  let added = 0;
  for (const template of BUILT_IN_TEMPLATES) {
    const existing = await prisma.emailTemplate.findUnique({ where: { key: template.key } });
    if (existing) continue;
    await prisma.emailTemplate.create({ data: { ...template, builtIn: true } });
    added += 1;
  }
  if (added) console.log(`[setup] Added ${added} built-in email template(s).`);
}

async function ensureFirstAdmin() {
  const usableAdmin = await prisma.employee.findFirst({
    where: { role: "ADMIN", passwordHash: { not: null } },
    select: { id: true },
  });
  if (usableAdmin) return;

  const email = process.env.FIRST_ADMIN_EMAIL?.trim().toLowerCase();
  if (!email || !email.includes("@")) {
    throw new Error(
      "No admin can sign in yet. Set FIRST_ADMIN_EMAIL (and optionally FIRST_ADMIN_NAME) " +
        "in the server's settings and start again; the invite link for that address is then " +
        "printed here."
    );
  }
  const [firstName, ...rest] = (process.env.FIRST_ADMIN_NAME?.trim() || "Firm Admin").split(/\s+/);
  const lastName = rest.join(" ") || "Admin";

  // A fresh token on every start until the invite is used, so an expired link
  // is never a dead end: restart the app and a new one is printed.
  const invite = { inviteToken: newToken(), inviteTokenExpiresAt: inviteExpiry() };
  const existing = await prisma.employee.findUnique({ where: { email } });
  if (existing) {
    await prisma.employee.update({ where: { id: existing.id }, data: { role: "ADMIN", ...invite } });
  } else {
    await prisma.employee.create({ data: { firstName, lastName, email, role: "ADMIN", passwordHash: null, ...invite } });
  }

  const base = (process.env.APP_URL?.trim() || "").replace(/\/+$/, "");
  const days = Math.round(INVITE_TTL_MS / 86_400_000);
  console.log(
    `\n[setup] First admin: ${email}\n` +
      `[setup] Open this link to set the password (valid ${days} days, single use):\n` +
      `[setup]   ${base}/invite/${invite.inviteToken}\n` +
      `[setup] Until it's used, every restart prints a new link and the old one stops working.\n`
  );
}

async function main() {
  await loadReferenceData();
  await loadEmailTemplates();
  await ensureFirstAdmin();
}

main()
  .catch((err) => {
    console.error(`[setup] ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
