"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { canMarkDone } from "@/lib/workflow";
import { resolveCurrentPeriod, getRecurring, isPeriodBefore } from "@/lib/periods";
import { openPeriodForAssignment, generatePeriods } from "@/lib/scheduler";
import { maybeRollPeriodForward } from "@/lib/rollover";
import {
  clampOffset,
  resolveStepDueDates,
  MIN_OFFSET_DAYS,
  MAX_OFFSET_DAYS,
} from "@/lib/due-dates";
import { resolveDefaultAssignees } from "@/lib/default-assignees";
import { formatMinutes } from "@/lib/time";
import { recordAudit, recordAuditMany, actorFrom, AUDIT, STATUS_WORDS } from "@/lib/audit";
import { objectStore, documentStorageKey, DEFAULT_BUCKET } from "@/lib/storage";
import { requireAdmin } from "@/lib/auth";
import {
  requireActivityAccess,
  requireAdminAction,
  requireClientAccess,
  requireEngagementAccess,
  assertEmployeeExists,
} from "@/lib/access";
import { newToken, inviteExpiry } from "@/lib/password";
import type { ActivityStatus, RecurringType, Role, SubtaskKind } from "@prisma/client";

// Every action guards itself — server actions are reachable by direct POST, not
// just through the UI, and proxy.ts only checks for a cookie. The rules are in
// src/lib/permissions.ts and enforced by src/lib/access.ts:
//   requireActivityAccess / requireEngagementAccess — work on an engagement the
//     caller is assigned to (admins: any).
//   requireClientAccess — edit a client the caller works with.
//   requireAdminAction — firm structure (clients, services, templates); throws.
//   requireAdmin — the older admin gate for config + user management; redirects.

export async function updateActivityStatus(
  activityId: string,
  newStatus: ActivityStatus
) {
  const { user } = await requireActivityAccess(activityId);
  const activity = await prisma.clientActivity.findUniqueOrThrow({
    where: { id: activityId },
    include: {
      subTask: { select: { name: true } },
      client: { select: { companyName: true } },
      project: { select: { name: true } },
    },
  });

  if (newStatus === "DONE") {
    const siblings = await prisma.clientActivity.findMany({
      where: {
        clientId: activity.clientId,
        projectId: activity.projectId,
        periodName: activity.periodName,
      },
    });
    if (!canMarkDone(activity, siblings)) {
      throw new Error(
        "Can't mark this task done until earlier tasks in this period are completed."
      );
    }
  }

  if (activity.status === newStatus) return;

  await prisma.clientActivity.update({
    where: { id: activityId },
    data: {
      status: newStatus,
      // Stamp the completion on the row itself. updatedAt can't serve this —
      // any later edit to notes or assignee overwrites it — and un-doing a
      // step has to clear it, or the record would claim a sign-off that was
      // withdrawn.
      completedAt: newStatus === "DONE" ? new Date() : null,
      completedById: newStatus === "DONE" ? user.id : null,
    },
  });

  await recordAudit({
    entityType: "ClientActivity",
    entityId: activityId,
    action: AUDIT.STATUS_CHANGED,
    summary: `${activity.subTask.name}: ${STATUS_WORDS[activity.status] ?? activity.status} → ${
      STATUS_WORDS[newStatus] ?? newStatus
    }`,
    fromValue: activity.status,
    toValue: newStatus,
    clientId: activity.clientId,
    projectId: activity.projectId,
    periodName: activity.periodName,
    contextLabel: `${activity.client.companyName} · ${activity.project.name}`,
    actor: actorFrom(user),
  });

  revalidatePath("/");
  revalidatePath("/tasks");
  revalidatePath("/activity");
  revalidatePath(`/assignments/${activity.clientId}/${activity.projectId}`);

  if (newStatus === "DONE") {
    await maybeRollPeriodForward(activity.clientId, activity.projectId, activity.periodName);
  }
}

export type ClientFormInput = {
  companyName: string;
  groupName?: string;
  corpTypeId?: string;
  businessTypeId?: string;
  address1?: string;
  address2?: string;
  city?: string;
  state?: string;
  zipcode?: string;
  phone?: string;
  fax?: string;
  taxId?: string;
  email?: string;
  note?: string;
  coRegDate?: string; // yyyy-mm-dd from a date input
  coRegState?: string;
  renewMonth?: string;
};

function normalizeClientInput(data: ClientFormInput) {
  if (!data.companyName.trim()) {
    throw new Error("Company name is required.");
  }
  return {
    companyName: data.companyName.trim(),
    groupName: data.groupName?.trim() || null,
    corpTypeId: data.corpTypeId?.trim() || null,
    businessTypeId: data.businessTypeId?.trim() || null,
    address1: data.address1?.trim() || null,
    address2: data.address2?.trim() || null,
    city: data.city?.trim() || null,
    state: data.state?.trim() || null,
    zipcode: data.zipcode?.trim() || null,
    phone: data.phone?.trim() || null,
    fax: data.fax?.trim() || null,
    taxId: data.taxId?.trim() || null,
    email: data.email?.trim() || null,
    note: data.note?.trim() || null,
    coRegDate: data.coRegDate ? new Date(data.coRegDate) : null,
    coRegState: data.coRegState?.trim() || null,
    renewMonth: data.renewMonth?.trim() || null,
  };
}

// Prisma known-request-error codes: P2002 = unique constraint, P2003 = FK
// constraint, P2025 = required record not found. Callers pass friendly text
// for whichever of these are actually reachable for their operation.
function rethrowFriendly(
  err: unknown,
  messages: { unique?: string; foreignKey?: string }
): never {
  if (err instanceof Error && "code" in err) {
    const code = (err as { code?: string }).code;
    if (code === "P2002" && messages.unique) throw new Error(messages.unique);
    if (code === "P2003" && messages.foreignKey) throw new Error(messages.foreignKey);
  }
  throw err;
}

export async function createClient(data: ClientFormInput) {
  await requireAdminAction();
  const values = normalizeClientInput(data);
  try {
    const client = await prisma.client.create({ data: values });
    await recordAudit({
      entityType: "Client",
      entityId: client.id,
      action: AUDIT.CLIENT_CREATED,
      summary: `Added client ${client.companyName}`,
      toValue: client.companyName,
      clientId: client.id,
      contextLabel: client.companyName,
    });
    revalidatePath("/clients");
    revalidatePath("/activity");
    return client;
  } catch (err) {
    rethrowFriendly(err, { unique: "That Tax ID is already in use by another client." });
  }
}

export async function updateClient(clientId: string, data: ClientFormInput) {
  await requireClientAccess(clientId);
  const values = normalizeClientInput(data);
  try {
    const client = await prisma.client.update({
      where: { id: clientId },
      data: values,
    });
    await recordAudit({
      entityType: "Client",
      entityId: clientId,
      action: AUDIT.CLIENT_UPDATED,
      summary: `Updated ${client.companyName}'s details`,
      clientId,
      contextLabel: client.companyName,
    });
    revalidatePath("/clients");
    revalidatePath(`/clients/${clientId}`);
    revalidatePath("/activity");
    return client;
  } catch (err) {
    rethrowFriendly(err, { unique: "That Tax ID is already in use by another client." });
  }
}

// --- Archiving and deleting clients ----------------------------------------------
//
// Archiving is the normal way to take a client off the books. It's a soft
// delete: the client disappears from the dashboard, tasks, projects, workload,
// reports, search and every picker, the scheduler stops opening new periods for
// it, and any open client-request links stop working — but nothing is removed.
// Restore brings it all back.
//
// Permanent deletion still exists, for a client created by mistake, but only
// once the client is archived AND has no history at all. It used to be a
// single guarded call away from any client page; now removing real history
// takes two deliberate steps and can't happen to a client with work on file.

function revalidateClientLists(clientId: string) {
  revalidatePath("/");
  revalidatePath("/tasks");
  revalidatePath("/clients");
  revalidatePath(`/clients/${clientId}`);
  revalidatePath("/projects");
  revalidatePath("/workload");
  revalidatePath("/activity");
}

export async function archiveClient(clientId: string) {
  const user = await requireAdminAction();
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { companyName: true, archivedAt: true },
  });
  if (!client) throw new Error("That client no longer exists.");
  if (client.archivedAt) return { cancelledRequests: 0 };

  const label = `${user.firstName} ${user.lastName}`;
  const [, cancelled] = await prisma.$transaction([
    prisma.client.update({
      where: { id: clientId },
      data: { archivedAt: new Date(), archivedByLabel: label },
    }),
    // A client we no longer serve shouldn't be able to keep uploading into
    // the firm through an old link.
    prisma.clientRequest.updateMany({
      where: { clientId, status: "OPEN" },
      data: { status: "CANCELLED" },
    }),
  ]);

  await recordAudit({
    entityType: "Client",
    entityId: clientId,
    action: AUDIT.CLIENT_ARCHIVED,
    summary: `Archived ${client.companyName}${
      cancelled.count > 0
        ? ` — ${cancelled.count} open client request link${cancelled.count === 1 ? "" : "s"} revoked`
        : ""
    }`,
    clientId,
    contextLabel: client.companyName,
    actor: actorFrom(user),
  });
  revalidateClientLists(clientId);
  return { cancelledRequests: cancelled.count };
}

// Restoring resumes the client from TODAY's period. The periods that passed
// while it was archived are deliberately not generated: the scheduler would
// otherwise treat six archived months as six months of overdue work and flood
// the board with checklists nobody was ever meant to do.
export async function restoreClient(clientId: string) {
  const user = await requireAdminAction();
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { companyName: true, archivedAt: true },
  });
  if (!client) throw new Error("That client no longer exists.");
  if (!client.archivedAt) return { resumed: 0 };

  await prisma.client.update({
    where: { id: clientId },
    data: { archivedAt: null, archivedByLabel: null },
  });

  const engagements = await prisma.projectClientMap.findMany({
    where: { clientId, active: true },
    include: { project: { include: { recurring: true, _count: { select: { subtasks: true } } } } },
  });
  let resumed = 0;
  for (const e of engagements) {
    const type = e.project.recurring.type;
    if (type === "ONE_TIME" || e.project._count.subtasks === 0) continue;
    const today = (await resolveCurrentPeriod(e.project.recurringId, type)).name;
    if (!e.currentPeriod || !isPeriodBefore(type, e.currentPeriod, today)) continue;
    await openPeriodForAssignment({
      clientId,
      projectId: e.projectId,
      periodName: today,
      project: {
        recurringId: e.project.recurringId,
        recurring: { type },
        dueOffsetDays: e.project.dueOffsetDays,
      },
      clientOverride: e.dueOffsetDays,
      engagementDefaultAssigneeId: e.defaultAssigneeId,
    });
    await prisma.projectClientMap.update({
      where: { clientId_projectId: { clientId, projectId: e.projectId } },
      data: { currentPeriod: today },
    });
    resumed += 1;
  }

  await recordAudit({
    entityType: "Client",
    entityId: clientId,
    action: AUDIT.CLIENT_RESTORED,
    summary: `Restored ${client.companyName}${
      resumed > 0
        ? ` — ${resumed} service${resumed === 1 ? "" : "s"} resumed from the current period`
        : ""
    }`,
    clientId,
    contextLabel: client.companyName,
    actor: actorFrom(user),
  });
  revalidateClientLists(clientId);
  return { resumed };
}

// Permanent. Only for an archived client with nothing on file — the source
// app's rule (no activity, no assigned services) widened to every kind of
// history the app now keeps. Contacts and tags cascade with the client.
export async function deleteClient(clientId: string) {
  const user = await requireAdminAction();
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { companyName: true, archivedAt: true },
  });
  if (!client) throw new Error("That client no longer exists.");
  if (!client.archivedAt) {
    throw new Error("Archive the client first. Only an archived client can be deleted permanently.");
  }
  const [activity, assignments, documents, time, emails, requests, notes] = await Promise.all([
    prisma.clientActivity.count({ where: { clientId } }),
    prisma.projectClientMap.count({ where: { clientId } }),
    prisma.document.count({ where: { clientId } }),
    prisma.timeEntry.count({ where: { clientId } }),
    prisma.emailMessage.count({ where: { clientId } }),
    prisma.clientRequest.count({ where: { clientId } }),
    prisma.assignmentNote.count({ where: { clientId } }),
  ]);
  const history = [
    [activity, "task"],
    [assignments, "service"],
    [documents, "file"],
    [time, "time entry", "time entries"],
    [emails, "email"],
    [requests, "client request"],
    [notes, "note"],
  ] as const;
  const onFile = history
    .filter(([n]) => n > 0)
    .map(([n, one, many]) => `${n} ${n === 1 ? one : many ?? `${one}s`}`);
  if (onFile.length > 0) {
    throw new Error(
      `This client has history on file (${onFile.join(", ")}), so it stays archived rather than being deleted.`
    );
  }

  await prisma.client.delete({ where: { id: clientId } });
  // Recorded after the delete and with no foreign key, so the history of a
  // removed client survives the client.
  await recordAudit({
    entityType: "Client",
    entityId: clientId,
    action: AUDIT.CLIENT_DELETED,
    summary: `Permanently deleted client ${client.companyName}`,
    fromValue: client.companyName,
    clientId,
    contextLabel: client.companyName,
    actor: actorFrom(user),
  });
  revalidateClientLists(clientId);
}

// Mirrors the source app's TRG_PROJ_CLIENT_INSERT_SUBTASKS trigger: assigning
// a project to a client generates one ClientActivity row per subtask in the
// project's template, for the given accounting period. When periodName is
// omitted, it's derived from the project's cadence (monthly/quarterly/
// annual/one-time) relative to today, creating that period if needed.
export async function assignProjectToClient(
  clientId: string,
  projectId: string,
  periodName?: string
) {
  await requireAdminAction();
  const existing = await prisma.projectClientMap.findUnique({
    where: { clientId_projectId: { clientId, projectId } },
  });
  if (existing) {
    throw new Error("This client is already assigned to this project.");
  }

  const taskMaps = await prisma.projectTaskMap.findMany({
    where: { projectId },
    orderBy: { sequence: "asc" },
  });
  if (taskMaps.length === 0) {
    throw new Error("This project has no checklist steps defined yet.");
  }

  const project = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    include: { recurring: true },
  });
  if (!periodName) {
    const period = await resolveCurrentPeriod(project.recurringId, project.recurring.type);
    periodName = period.name;
  }

  await prisma.projectClientMap.create({
    data: {
      clientId,
      projectId,
      active: true,
      createSubtask: true,
      currentPeriod: periodName,
      startDate: new Date(),
    },
  });

  // Generated through the shared helper so due dates are resolved from the
  // project's rule the same way the nightly job resolves them. If this throws
  // after the assignment row lands, the engagement exists with no task rows —
  // which is exactly the state the scheduler repairs on its next run.
  await openPeriodForAssignment({
    clientId,
    projectId,
    periodName,
    project: {
      recurringId: project.recurringId,
      recurring: { type: project.recurring.type },
      dueOffsetDays: project.dueOffsetDays,
    },
    clientOverride: null,
    // A brand-new engagement has no default owner yet; set one on the
    // assignment page and the next period picks it up.
    engagementDefaultAssigneeId: null,
  });

  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { companyName: true },
  });
  await recordAudit({
    entityType: "ProjectClientMap",
    entityId: `${clientId}:${projectId}`,
    action: AUDIT.ENGAGEMENT_CREATED,
    summary: `${client?.companyName ?? "Client"} added to ${project.name} (${periodName})`,
    toValue: periodName,
    clientId,
    projectId,
    periodName,
    contextLabel: `${client?.companyName ?? "Client"} · ${project.name}`,
  });

  revalidatePath("/");
  revalidatePath("/tasks");
  revalidatePath("/projects");
  revalidatePath(`/projects/${projectId}`);
  revalidatePath(`/clients/${clientId}`);
  revalidatePath("/activity");
}

// --- Client contacts --------------------------------------------------------
//
// CorpContact create/edit/delete. ssnEncrypted is deliberately not exposed
// here: it has no encryption behind it yet, so no UI should be inviting SSNs
// in until that exists (see PROJECT_NOTES.md).

export type ContactInput = {
  firstName?: string;
  lastName?: string;
  mobile?: string;
  email?: string;
  note?: string;
};

function normalizeContactInput(data: ContactInput) {
  const values = {
    firstName: data.firstName?.trim() || null,
    lastName: data.lastName?.trim() || null,
    mobile: data.mobile?.trim() || null,
    email: data.email?.trim() || null,
    note: data.note?.trim() || null,
  };
  if (!values.firstName && !values.lastName && !values.email && !values.mobile) {
    throw new Error("A contact needs at least a name, email, or mobile number.");
  }
  return values;
}

export async function createContact(clientId: string, data: ContactInput) {
  await requireClientAccess(clientId);
  const values = normalizeContactInput(data);
  const contact = await prisma.corpContact.create({ data: { clientId, ...values } });
  revalidatePath(`/clients/${clientId}`);
  revalidatePath("/reports/client-information-list");
  return contact;
}

// A contact id alone says nothing about access, so resolve it to its client
// first and check that.
async function requireContactAccess(contactId: string) {
  const contact = await prisma.corpContact.findUnique({
    where: { id: contactId },
    select: { clientId: true },
  });
  if (!contact) throw new Error("That contact no longer exists.");
  await requireClientAccess(contact.clientId);
}

export async function updateContact(contactId: string, data: ContactInput) {
  await requireContactAccess(contactId);
  const values = normalizeContactInput(data);
  const contact = await prisma.corpContact.update({ where: { id: contactId }, data: values });
  revalidatePath(`/clients/${contact.clientId}`);
  return contact;
}

export async function deleteContact(contactId: string) {
  await requireContactAccess(contactId);
  const contact = await prisma.corpContact.delete({ where: { id: contactId } });
  revalidatePath(`/clients/${contact.clientId}`);
}

// --- Lookups: Corporation Type / Business Type -----------------------------

export async function createCorporationType(name: string) {
  await requireAdmin();
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Name is required.");
  try {
    const created = await prisma.corporationType.create({ data: { name: trimmed } });
    revalidatePath("/admin/business-types");
    return created;
  } catch (err) {
    rethrowFriendly(err, { unique: "A corporation type with that name already exists." });
  }
}

export async function deleteCorporationType(id: string) {
  await requireAdmin();
  const inUse = await prisma.client.count({ where: { corpTypeId: id } });
  if (inUse > 0) {
    throw new Error("This corporation type is assigned to one or more clients.");
  }
  await prisma.corporationType.delete({ where: { id } });
  revalidatePath("/admin/business-types");
}

export async function createBusinessType(name: string) {
  await requireAdmin();
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Name is required.");
  try {
    const created = await prisma.businessType.create({ data: { name: trimmed } });
    revalidatePath("/admin/business-types");
    return created;
  } catch (err) {
    rethrowFriendly(err, { unique: "A business type with that name already exists." });
  }
}

export async function deleteBusinessType(id: string) {
  await requireAdmin();
  const inUse = await prisma.client.count({ where: { businessTypeId: id } });
  if (inUse > 0) {
    throw new Error("This business type is assigned to one or more clients.");
  }
  await prisma.businessType.delete({ where: { id } });
  revalidatePath("/admin/business-types");
}

// --- Employees --------------------------------------------------------------

export type EmployeeFormInput = {
  firstName: string;
  lastName: string;
  email: string;
  role: Role;
  phone?: string;
  mobile?: string;
  country?: string;
  employeeTypeId?: string;
};

function normalizeEmployeeInput(data: EmployeeFormInput) {
  if (!data.firstName.trim() || !data.lastName.trim()) {
    throw new Error("First and last name are required.");
  }
  const email = data.email.trim().toLowerCase();
  if (!email || !email.includes("@")) {
    throw new Error("A valid email is required — it's how they sign in.");
  }
  return {
    firstName: data.firstName.trim(),
    lastName: data.lastName.trim(),
    email,
    role: data.role,
    phone: data.phone?.trim() || null,
    mobile: data.mobile?.trim() || null,
    country: data.country?.trim() || null,
    employeeTypeId: data.employeeTypeId?.trim() || null,
  };
}

// Creating an employee also issues an invite: the row starts with no
// passwordHash and a fresh inviteToken. The admin copies the /invite/<token>
// link from the employees page and sends it however they like.
export async function createEmployee(data: EmployeeFormInput) {
  await requireAdmin();
  const values = normalizeEmployeeInput(data);
  try {
    const employee = await prisma.employee.create({
      data: {
        ...values,
        passwordHash: null,
        inviteToken: newToken(),
        inviteTokenExpiresAt: inviteExpiry(),
      },
    });
    await recordAudit({
      entityType: "Employee",
      entityId: employee.id,
      action: AUDIT.EMPLOYEE_CREATED,
      summary: `Added ${employee.firstName} ${employee.lastName} (${employee.email}) and issued an invite`,
      toValue: employee.email,
      contextLabel: `${employee.firstName} ${employee.lastName}`,
    });
    revalidatePath("/admin/employees");
    revalidatePath("/activity");
    return employee;
  } catch (err) {
    rethrowFriendly(err, { unique: "That email is already in use by another employee." });
  }
}

export async function updateEmployee(employeeId: string, data: EmployeeFormInput) {
  await requireAdmin();
  const values = normalizeEmployeeInput(data);
  if (values.role !== "ADMIN") await assertNotLastAdmin(employeeId);
  try {
    const employee = await prisma.employee.update({ where: { id: employeeId }, data: values });
    await recordAudit({
      entityType: "Employee",
      entityId: employee.id,
      action: AUDIT.EMPLOYEE_UPDATED,
      summary: `Updated ${employee.firstName} ${employee.lastName}'s details`,
      toValue: employee.email,
      contextLabel: `${employee.firstName} ${employee.lastName}`,
    });
    revalidatePath("/admin/employees");
    revalidatePath("/activity");
    return employee;
  } catch (err) {
    rethrowFriendly(err, { unique: "That email is already in use by another employee." });
  }
}

export async function deleteEmployee(employeeId: string) {
  await requireAdmin();
  const assigned = await prisma.clientActivity.count({ where: { assigneeId: employeeId } });
  if (assigned > 0) {
    throw new Error("This employee has assigned tasks and can't be deleted.");
  }
  await assertNotLastAdmin(employeeId);
  await prisma.employee.delete({ where: { id: employeeId } }); // sessions cascade
  revalidatePath("/admin/employees");
}

// Guards against locking everyone out: refuses to demote / disable / delete the
// last employee who is both ADMIN and has an active login.
async function assertNotLastAdmin(employeeId: string) {
  const activeAdmins = await prisma.employee.findMany({
    where: { role: "ADMIN", passwordHash: { not: null } },
    select: { id: true },
  });
  if (activeAdmins.length <= 1 && activeAdmins.some((a) => a.id === employeeId)) {
    throw new Error("There must be at least one admin with an active account.");
  }
}

export async function setEmployeeRole(employeeId: string, role: Role) {
  const admin = await requireAdmin();
  if (role !== "ADMIN") await assertNotLastAdmin(employeeId);
  const before = await prisma.employee.findUniqueOrThrow({ where: { id: employeeId } });
  if (before.role === role) return;

  await prisma.employee.update({ where: { id: employeeId }, data: { role } });
  await recordAudit({
    entityType: "Employee",
    entityId: employeeId,
    action: AUDIT.ROLE_CHANGED,
    summary: `${before.firstName} ${before.lastName}: ${before.role} → ${role}`,
    fromValue: before.role,
    toValue: role,
    contextLabel: `${before.firstName} ${before.lastName}`,
    actor: actorFrom(admin),
  });
  revalidatePath("/admin/employees");
  revalidatePath("/activity");
  revalidatePath("/");
}

// Re-arm an invite whose link was lost or expired. Only valid while the account
// is still invite-pending (no password set).
export async function regenerateInvite(employeeId: string) {
  await requireAdmin();
  const employee = await prisma.employee.findUniqueOrThrow({ where: { id: employeeId } });
  if (employee.passwordHash) {
    throw new Error("This account is already active — use Revoke first to re-invite.");
  }
  const updated = await prisma.employee.update({
    where: { id: employeeId },
    data: { inviteToken: newToken(), inviteTokenExpiresAt: inviteExpiry() },
  });
  await recordAudit({
    entityType: "Employee",
    entityId: employeeId,
    action: AUDIT.INVITE_ISSUED,
    summary: `Issued a new invite link for ${employee.firstName} ${employee.lastName}`,
    contextLabel: `${employee.firstName} ${employee.lastName}`,
  });
  revalidatePath("/admin/employees");
  revalidatePath("/activity");
  return { inviteToken: updated.inviteToken! };
}

// Cut off an active employee's access without deleting their history: clears
// the password, kills their sessions, and re-issues an invite so they can be
// brought back later.
export async function revokeAccess(employeeId: string) {
  const admin = await requireAdmin();
  await assertNotLastAdmin(employeeId);
  const target = await prisma.employee.findUniqueOrThrow({ where: { id: employeeId } });

  await prisma.$transaction([
    prisma.session.deleteMany({ where: { employeeId } }),
    prisma.employee.update({
      where: { id: employeeId },
      data: {
        passwordHash: null,
        inviteToken: newToken(),
        inviteTokenExpiresAt: inviteExpiry(),
        // Revoking clears any outstanding reset link too — otherwise a link
        // mailed five minutes earlier would hand the account straight back.
        resetTokenHash: null,
        resetTokenExpiresAt: null,
        passwordChangedAt: new Date(),
      },
    }),
  ]);

  await recordAudit({
    entityType: "Employee",
    entityId: employeeId,
    action: AUDIT.ACCESS_REVOKED,
    summary: `Revoked access for ${target.firstName} ${target.lastName} — sessions ended, password cleared`,
    contextLabel: `${target.firstName} ${target.lastName}`,
    actor: actorFrom(admin),
  });
  revalidatePath("/admin/employees");
  revalidatePath("/activity");
  revalidatePath("/");
}

export async function createEmployeeType(name: string) {
  await requireAdmin();
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Name is required.");
  try {
    const created = await prisma.employeeType.create({ data: { name: trimmed } });
    revalidatePath("/admin/employees");
    return created;
  } catch (err) {
    rethrowFriendly(err, { unique: "An employee type with that name already exists." });
  }
}

// --- Projects (service templates) -------------------------------------------

export type ProjectFormInput = {
  name: string;
  description?: string;
  recurring: RecurringType;
  // The service's deadline rule: days after the period's end date. Omitted by
  // older callers, which keeps the previous behaviour (due on the last day).
  dueOffsetDays?: number;
};

export async function createProject(data: ProjectFormInput) {
  await requireAdmin();
  const name = data.name.trim();
  if (!name) throw new Error("Project name is required.");
  const recurring = await getRecurring(data.recurring);
  try {
    const project = await prisma.project.create({
      data: {
        name,
        description: data.description?.trim() || null,
        recurringId: recurring.id,
        dueOffsetDays: clampOffset(data.dueOffsetDays ?? 0),
      },
    });
    revalidatePath("/admin/projects");
    return project;
  } catch (err) {
    rethrowFriendly(err, { unique: "A project with that name already exists." });
  }
}

export async function updateProject(projectId: string, data: ProjectFormInput) {
  await requireAdmin();
  const name = data.name.trim();
  if (!name) throw new Error("Project name is required.");
  const recurring = await getRecurring(data.recurring);
  try {
    const project = await prisma.project.update({
      where: { id: projectId },
      data: {
        name,
        description: data.description?.trim() || null,
        recurringId: recurring.id,
        dueOffsetDays: clampOffset(data.dueOffsetDays ?? 0),
      },
    });
    // The deadline rule may have moved; existing task rows are stale until
    // they're recomputed from it.
    await recomputeDueDates({ projectId });
    revalidatePath("/admin/projects");
    revalidatePath("/");
    revalidatePath("/tasks");
    return project;
  } catch (err) {
    rethrowFriendly(err, { unique: "A project with that name already exists." });
  }
}

export async function deleteProject(projectId: string) {
  await requireAdmin();
  const assigned = await prisma.projectClientMap.count({ where: { projectId } });
  if (assigned > 0) {
    throw new Error("This project is assigned to one or more clients and can't be deleted.");
  }
  await prisma.projectTaskMap.deleteMany({ where: { projectId } });
  await prisma.project.delete({ where: { id: projectId } });
  revalidatePath("/admin/projects");
}

// --- Project subtasks (the master checklist-step catalog) -------------------

export type ProjectSubTaskInput = { name: string; note?: string };

export async function createProjectSubTask(data: ProjectSubTaskInput) {
  await requireAdmin();
  const name = data.name.trim();
  if (!name) throw new Error("Task name is required.");
  const created = await prisma.projectSubTask.create({
    data: { name, note: data.note?.trim() || null },
  });
  revalidatePath("/admin/projects-task");
  return created;
}

export async function updateProjectSubTask(subTaskId: string, data: ProjectSubTaskInput) {
  await requireAdmin();
  const name = data.name.trim();
  if (!name) throw new Error("Task name is required.");
  const updated = await prisma.projectSubTask.update({
    where: { id: subTaskId },
    data: { name, note: data.note?.trim() || null },
  });
  revalidatePath("/admin/projects-task");
  return updated;
}

export async function deleteProjectSubTask(subTaskId: string) {
  await requireAdmin();
  const [inMap, inActivity] = await Promise.all([
    prisma.projectTaskMap.count({ where: { subTaskId } }),
    prisma.clientActivity.count({ where: { subTaskId } }),
  ]);
  if (inMap > 0 || inActivity > 0) {
    throw new Error("This task is used in a project checklist and can't be deleted.");
  }
  await prisma.projectSubTask.delete({ where: { id: subTaskId } });
  revalidatePath("/admin/projects-task");
}

// --- Project task map (which subtasks belong to which project, in what order)

export async function addProjectTaskMap(
  projectId: string,
  subTaskId: string,
  sequence: number
) {
  await requireAdmin();
  const existing = await prisma.projectTaskMap.findUnique({
    where: { projectId_subTaskId: { projectId, subTaskId } },
  });
  if (existing) {
    throw new Error("That task is already on this project's checklist.");
  }
  await prisma.projectTaskMap.create({ data: { projectId, subTaskId, sequence } });
  revalidatePath("/admin/projects-task-map");
  revalidatePath("/clients/new");
}

export async function removeProjectTaskMap(projectId: string, subTaskId: string) {
  await requireAdmin();
  const inUse = await prisma.clientActivity.count({ where: { projectId, subTaskId } });
  if (inUse > 0) {
    throw new Error(
      "Clients already have activity on this step, remove it from their checklists first."
    );
  }
  await prisma.projectTaskMap.delete({
    where: { projectId_subTaskId: { projectId, subTaskId } },
  });
  revalidatePath("/admin/projects-task-map");
  revalidatePath("/clients/new");
}

// --- Project builder (admin) --------------------------------------------------
//
// The admin catalog above is the firm's fixed service list. This section is
// the FinancialCents-style flow: create a project and build its checklist
// directly on /projects/[id] — add a task, rename it, drag it into place,
// remove it. It used to be open to any employee, but a template edit changes
// the work of every client on the service (including clients the editor can't
// see), and an employee who created a project was immediately redirected away
// from it by the visibility scope anyway. Employees see the page read-only. Each task here is a ProjectSubTask + a
// ProjectTaskMap row on this project, so everything downstream (assigning
// clients, period rollover, admin pages) keeps working unchanged.
//
// Ordering: the checklist is renumbered 10, 20, 30… on every reorder, the
// same convention the seeded templates use. Reordering the template affects
// task rows generated from here on (new assignments, next period); rows
// already generated for a client's current period keep their taskSeqNo.

function revalidateProjectBuilder(projectId: string) {
  revalidatePath("/projects");
  revalidatePath(`/projects/${projectId}`);
  revalidatePath("/admin/projects");
  revalidatePath("/admin/projects-task");
  revalidatePath("/admin/projects-task-map");
  revalidatePath("/clients/new");
  revalidatePath("/reports/project-task-compare");
}

const SEQUENCE_STEP = 10;

export async function createOwnProject(data: ProjectFormInput) {
  await requireAdminAction();
  const name = data.name.trim();
  if (!name) throw new Error("Project name is required.");
  const recurring = await getRecurring(data.recurring);
  try {
    const project = await prisma.project.create({
      data: {
        name,
        description: data.description?.trim() || null,
        recurringId: recurring.id,
        dueOffsetDays: clampOffset(data.dueOffsetDays ?? 0),
      },
    });
    revalidateProjectBuilder(project.id);
    return { id: project.id };
  } catch (err) {
    rethrowFriendly(err, { unique: "A project with that name already exists." });
  }
}

export async function addChecklistTask(projectId: string, name: string) {
  await requireAdminAction();
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Task name is required.");
  await prisma.project.findUniqueOrThrow({ where: { id: projectId } });

  const last = await prisma.projectTaskMap.findFirst({
    where: { projectId },
    orderBy: { sequence: "desc" },
  });
  const sequence = (last?.sequence ?? 0) + SEQUENCE_STEP;

  const created = await prisma.projectSubTask.create({
    data: {
      name: trimmed,
      taskMaps: { create: { projectId, sequence } },
    },
  });
  revalidateProjectBuilder(projectId);
  return { subTaskId: created.id, sequence };
}

export async function renameChecklistTask(projectId: string, subTaskId: string, name: string) {
  await requireAdminAction();
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Task name is required.");

  const usedElsewhere = await prisma.projectTaskMap.count({
    where: { subTaskId, NOT: { projectId } },
  });
  if (usedElsewhere > 0) {
    throw new Error(
      "This step is shared with other projects. Rename it from Admin → Projects Task instead."
    );
  }
  await prisma.projectSubTask.update({ where: { id: subTaskId }, data: { name: trimmed } });
  revalidateProjectBuilder(projectId);
}

export async function removeChecklistTask(projectId: string, subTaskId: string) {
  await requireAdminAction();
  const inUse = await prisma.clientActivity.count({ where: { projectId, subTaskId } });
  if (inUse > 0) {
    throw new Error("Clients already have activity on this step, so it can't be removed.");
  }

  const remaining = await prisma.projectTaskMap.findMany({
    where: { projectId, NOT: { subTaskId } },
    orderBy: { sequence: "asc" },
  });
  const orphaned =
    (await prisma.projectTaskMap.count({ where: { subTaskId, NOT: { projectId } } })) === 0 &&
    (await prisma.clientActivity.count({ where: { subTaskId } })) === 0;

  await prisma.$transaction([
    prisma.projectTaskMap.delete({ where: { projectId_subTaskId: { projectId, subTaskId } } }),
    // A task created for this project only would otherwise linger in the
    // master list forever; drop it when nothing else references it.
    ...(orphaned ? [prisma.projectSubTask.delete({ where: { id: subTaskId } })] : []),
    // Close the gap so the numbering stays 10, 20, 30…
    ...remaining.map((tm, i) =>
      prisma.projectTaskMap.update({
        where: { projectId_subTaskId: { projectId, subTaskId: tm.subTaskId } },
        data: { sequence: (i + 1) * SEQUENCE_STEP },
      })
    ),
  ]);
  revalidateProjectBuilder(projectId);
}

// `orderedSubTaskIds` is the full checklist in its new order. Must contain
// exactly the steps currently on the project — this guards against a stale
// drag committing over a concurrent add/remove.
export async function reorderChecklist(projectId: string, orderedSubTaskIds: string[]) {
  await requireAdminAction();
  const current = await prisma.projectTaskMap.findMany({ where: { projectId } });
  const currentIds = new Set(current.map((tm) => tm.subTaskId));
  const sameSet =
    orderedSubTaskIds.length === currentIds.size &&
    orderedSubTaskIds.every((id) => currentIds.has(id)) &&
    new Set(orderedSubTaskIds).size === orderedSubTaskIds.length;
  if (!sameSet) {
    throw new Error("The checklist changed while you were reordering. Refresh and try again.");
  }

  await prisma.$transaction(
    orderedSubTaskIds.map((subTaskId, i) =>
      prisma.projectTaskMap.update({
        where: { projectId_subTaskId: { projectId, subTaskId } },
        data: { sequence: (i + 1) * SEQUENCE_STEP },
      })
    )
  );
  revalidateProjectBuilder(projectId);
}

// --- Accounting periods -------------------------------------------------

export async function createAccountingPeriod(data: {
  name: string;
  recurring: RecurringType;
  startDate: string;
  endDate: string;
}) {
  await requireAdmin();
  const name = data.name.trim();
  if (!name) throw new Error("Period name is required.");
  if (!data.startDate || !data.endDate) throw new Error("Start and end date are required.");
  const recurring = await getRecurring(data.recurring);
  try {
    const period = await prisma.accountingPeriod.create({
      data: {
        name,
        startDate: new Date(data.startDate),
        endDate: new Date(data.endDate),
        recurringId: recurring.id,
      },
    });
    revalidatePath("/admin/accounting-periods");
    return period;
  } catch (err) {
    rethrowFriendly(err, { unique: "A period with that name already exists." });
  }
}

// --- Admin overrides on ClientActivity (notes, assignee) ---------------------

export async function updateActivityDetails(
  activityId: string,
  data: { notes?: string; assigneeId?: string }
) {
  await requireAdmin();
  await prisma.clientActivity.update({
    where: { id: activityId },
    data: {
      notes: data.notes?.trim() || null,
      assigneeId: data.assigneeId || null,
    },
  });
  revalidatePath("/admin/client-activity");
  revalidatePath("/");
}

// --- Assignment detail: subtasks, assignees, notes, documents ---------------
//
// The assignment detail page (/assignments/[clientId]/[projectId]) is the
// workspace for one client engagement. These actions back its List tab
// (per-step subtasks), the Assignees panel (bulk assignment), the Notes tab,
// and the Files tab. Every mutation revalidates the dashboard, this page, and
// the client detail page, since all three surface assignment state. All are
// operational — any signed-in employee may run them.

function revalidateAssignment(clientId: string, projectId: string) {
  revalidatePath("/");
  revalidatePath(`/assignments/${clientId}/${projectId}`);
  revalidatePath(`/clients/${clientId}`);
}

// Subtasks are advisory — see the ActivitySubtask comment in schema.prisma.
// They don't touch ClientActivity.status or the sequential-completion rule.

export async function addActivitySubtask(
  activityId: string,
  data: { name: string; kind: SubtaskKind }
) {
  const { activity } = await requireActivityAccess(activityId);
  const name = data.name.trim();
  if (!name) throw new Error("Subtask name is required.");
  const last = await prisma.activitySubtask.findFirst({
    where: { activityId },
    orderBy: { sequence: "desc" },
    select: { sequence: true },
  });
  const created = await prisma.activitySubtask.create({
    data: { activityId, name, kind: data.kind, sequence: (last?.sequence ?? 0) + 10 },
  });
  revalidateAssignment(activity.clientId, activity.projectId);
  return created;
}

// Subtask ids resolve to their parent step, which is what access is judged on.
async function requireSubtaskAccess(id: string) {
  const subtask = await prisma.activitySubtask.findUnique({
    where: { id },
    select: { activityId: true },
  });
  if (!subtask) throw new Error("That subtask no longer exists.");
  await requireActivityAccess(subtask.activityId);
}

export async function toggleActivitySubtask(id: string, done: boolean) {
  await requireSubtaskAccess(id);
  const updated = await prisma.activitySubtask.update({
    where: { id },
    data: { done },
    include: { activity: { select: { clientId: true, projectId: true } } },
  });
  revalidateAssignment(updated.activity.clientId, updated.activity.projectId);
}

export async function renameActivitySubtask(id: string, name: string) {
  await requireSubtaskAccess(id);
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Subtask name is required.");
  const updated = await prisma.activitySubtask.update({
    where: { id },
    data: { name: trimmed },
    include: { activity: { select: { clientId: true, projectId: true } } },
  });
  revalidateAssignment(updated.activity.clientId, updated.activity.projectId);
}

export async function deleteActivitySubtask(id: string) {
  await requireSubtaskAccess(id);
  const deleted = await prisma.activitySubtask.delete({
    where: { id },
    include: { activity: { select: { clientId: true, projectId: true } } },
  });
  revalidateAssignment(deleted.activity.clientId, deleted.activity.projectId);
}

// One assignee per step (unchanged model). This is the inline per-row control;
// bulkAssignActivities below is the Assignees panel.
export async function setActivityAssignee(activityId: string, employeeId: string) {
  const { user } = await requireActivityAccess(activityId);
  await assertEmployeeExists(employeeId || null);
  const before = await prisma.clientActivity.findUniqueOrThrow({
    where: { id: activityId },
    include: { subTask: { select: { name: true } }, assignee: true },
  });
  const nextId = employeeId || null;
  if (before.assigneeId === nextId) return;

  const updated = await prisma.clientActivity.update({
    where: { id: activityId },
    data: { assigneeId: nextId },
    include: { assignee: true },
  });

  await recordAudit({
    entityType: "ClientActivity",
    entityId: activityId,
    action: AUDIT.ASSIGNEE_CHANGED,
    summary: `${before.subTask.name}: ${employeeName(before.assignee)} → ${employeeName(updated.assignee)}`,
    fromValue: before.assigneeId,
    toValue: nextId,
    clientId: updated.clientId,
    projectId: updated.projectId,
    periodName: updated.periodName,
    actor: actorFrom(user),
  });

  revalidateAssignment(updated.clientId, updated.projectId);
}

// "Unassigned" is the honest label for a null assignee in a history entry —
// an empty string would read as data loss.
function employeeName(e: { firstName: string; lastName: string } | null): string {
  return e ? `${e.firstName} ${e.lastName}` : "Unassigned";
}

export type BulkAssignTarget =
  | { mode: "unassigned" }
  | { mode: "selected"; activityIds: string[] };

// Assign one employee (or clear, when employeeId is "") across a period's
// steps: either every currently-unassigned step, or a hand-picked subset.
// Returns how many rows changed so the panel can report it.
export async function bulkAssignActivities(
  clientId: string,
  projectId: string,
  periodName: string,
  employeeId: string,
  target: BulkAssignTarget
): Promise<number> {
  const user = await requireEngagementAccess(clientId, projectId);
  const assigneeId = employeeId || null;
  await assertEmployeeExists(assigneeId);
  const base = { clientId, projectId, periodName };

  const where =
    target.mode === "unassigned"
      ? { ...base, assigneeId: null }
      : { ...base, id: { in: target.activityIds } };
  if (target.mode === "selected" && target.activityIds.length === 0) return 0;

  // Read the rows first: after updateMany there is no way to know what each
  // one used to say, and a bulk reassignment is exactly the kind of change
  // someone needs to be able to reconstruct later.
  const before = await prisma.clientActivity.findMany({
    where,
    include: { subTask: { select: { name: true } }, assignee: true },
  });
  const changed = before.filter((a) => a.assigneeId !== assigneeId);

  const result = await prisma.clientActivity.updateMany({ where, data: { assigneeId } });

  const who = assigneeId
    ? await prisma.employee.findUnique({ where: { id: assigneeId } })
    : null;
  await recordAuditMany(
    changed.map((a) => ({
      entityType: "ClientActivity",
      entityId: a.id,
      action: AUDIT.ASSIGNEE_CHANGED,
      summary: `${a.subTask.name}: ${employeeName(a.assignee)} → ${employeeName(who)} (bulk)`,
      fromValue: a.assigneeId,
      toValue: assigneeId,
      clientId,
      projectId,
      periodName,
      actor: actorFrom(user),
    }))
  );

  revalidateAssignment(clientId, projectId);
  return result.count;
}

export async function addAssignmentNote(
  clientId: string,
  projectId: string,
  data: { body: string; authorId?: string }
) {
  const user = await requireEngagementAccess(clientId, projectId);
  const body = data.body.trim();
  if (!body) throw new Error("Note can't be empty.");
  // The author is whoever is signed in. It used to be taken from the request,
  // which let anyone post a note under a colleague's name.
  const created = await prisma.assignmentNote.create({
    data: { clientId, projectId, body, authorId: user.id },
  });
  revalidateAssignment(clientId, projectId);
  return created;
}

// Notes are a shared log, so only the person who wrote one (or an admin) may
// change or remove it — the same rule task comments follow. A note with no
// recorded author predates that and is admin-only.
async function requireNoteOwnership(id: string) {
  const note = await prisma.assignmentNote.findUnique({
    where: { id },
    select: { clientId: true, projectId: true, authorId: true },
  });
  if (!note) throw new Error("That note no longer exists.");
  const user = await requireEngagementAccess(note.clientId, note.projectId);
  if (user.role !== "ADMIN" && note.authorId !== user.id) {
    throw new Error("Only the person who wrote a note (or an admin) can change it.");
  }
}

export async function updateAssignmentNote(id: string, data: { body: string }) {
  await requireNoteOwnership(id);
  const body = data.body.trim();
  if (!body) throw new Error("Note can't be empty.");
  const updated = await prisma.assignmentNote.update({ where: { id }, data: { body } });
  revalidateAssignment(updated.clientId, updated.projectId);
}

export async function deleteAssignmentNote(id: string) {
  await requireNoteOwnership(id);
  const deleted = await prisma.assignmentNote.delete({ where: { id } });
  revalidateAssignment(deleted.clientId, deleted.projectId);
}

// Files tab. Bytes go to the ObjectStore (local disk today, Supabase Storage
// later — see src/lib/storage.ts); the Document row is the catalog entry.
// The row id is generated up front so it can seed a collision-proof storage
// key, and the bytes are written before the row so a failure can never leave a
// Document pointing at nothing.
export async function uploadDocument(formData: FormData) {
  const clientId = String(formData.get("clientId") ?? "");
  const projectId = String(formData.get("projectId") ?? "");
  const periodName = String(formData.get("periodName") ?? "") || null;
  const file = formData.get("file");

  if (!clientId || !projectId) throw new Error("Missing engagement reference.");
  const user = await requireEngagementAccess(clientId, projectId);
  // Recorded from the session, not the form — see addAssignmentNote.
  const uploadedById = user.id;
  if (!(file instanceof File) || file.size === 0) {
    throw new Error("Choose a file to upload.");
  }

  const id = randomUUID();
  const storageKey = documentStorageKey(clientId, projectId, id, file.name);
  const mimeType = file.type || "application/octet-stream";
  const bytes = Buffer.from(await file.arrayBuffer());

  await objectStore.put(DEFAULT_BUCKET, storageKey, bytes, mimeType);
  try {
    await prisma.document.create({
      data: {
        id,
        clientId,
        projectId,
        periodName,
        uploadedById,
        filename: file.name,
        mimeType,
        size: file.size,
        bucket: DEFAULT_BUCKET,
        storageKey,
      },
    });
  } catch (err) {
    await objectStore.remove(DEFAULT_BUCKET, storageKey).catch(() => {});
    rethrowFriendly(err, { foreignKey: "That client or project no longer exists." });
  }

  revalidateAssignment(clientId, projectId);
}

export async function deleteDocument(id: string) {
  const existing = await prisma.document.findUnique({
    where: { id },
    select: { clientId: true, projectId: true },
  });
  if (!existing) throw new Error("That file no longer exists.");
  await requireEngagementAccess(existing.clientId, existing.projectId);
  const doc = await prisma.document.delete({ where: { id } });
  await objectStore.remove(doc.bucket, doc.storageKey).catch(() => {});
  revalidateAssignment(doc.clientId, doc.projectId);
}

// --- Due dates ---------------------------------------------------------------
//
// ClientActivity.dueDate is derived data: project rule → client override →
// step offset. It's materialized onto the row so the dashboard can sort and
// filter in the database, which means every edit to a rule has to write the
// affected rows back. recomputeDueDates is that write.
//
// Rows a human dated by hand (dueDateOverridden) are never touched — an
// extension typed in for one client must survive someone editing the
// service's rule.

// Internal: NOT exported. Every export of a "use server" module is a public
// POST endpoint, and this one used to be callable by anyone signed in.
async function recomputeDueDates(scope: {
  projectId: string;
  clientId?: string;
}): Promise<number> {
  const project = await prisma.project.findUnique({
    where: { id: scope.projectId },
    select: { dueOffsetDays: true },
  });
  if (!project) return 0;

  const [taskMaps, assignments, activities] = await Promise.all([
    prisma.projectTaskMap.findMany({
      where: { projectId: scope.projectId },
      select: { subTaskId: true, dueOffsetDays: true },
    }),
    prisma.projectClientMap.findMany({
      where: { projectId: scope.projectId, ...(scope.clientId ? { clientId: scope.clientId } : {}) },
      select: { clientId: true, dueOffsetDays: true },
    }),
    prisma.clientActivity.findMany({
      where: {
        projectId: scope.projectId,
        ...(scope.clientId ? { clientId: scope.clientId } : {}),
        dueDateOverridden: false,
      },
      select: { id: true, clientId: true, subTaskId: true, periodName: true, dueDate: true },
    }),
  ]);
  if (activities.length === 0) return 0;

  const periods = await prisma.accountingPeriod.findMany({
    where: { name: { in: [...new Set(activities.map((a) => a.periodName))] } },
    select: { name: true, endDate: true },
  });
  const periodEnd = new Map(periods.map((p) => [p.name, p.endDate]));
  const overrideByClient = new Map(assignments.map((a) => [a.clientId, a.dueOffsetDays]));

  // One resolve per (client, period) pair rather than per row — a firm with
  // 400 engagements on a 12-step checklist is 4,800 rows but only 400 pairs.
  const resolved = new Map<string, Map<string, Date>>();
  function datesFor(clientId: string, periodName: string): Map<string, Date> | null {
    const key = `${clientId}:${periodName}`;
    const hit = resolved.get(key);
    if (hit) return hit;
    const end = periodEnd.get(periodName);
    if (!end) return null;
    const map = resolveStepDueDates({
      periodEnd: end,
      projectOffset: project!.dueOffsetDays,
      clientOverride: overrideByClient.get(clientId) ?? null,
      steps: taskMaps.map((tm) => ({ subTaskId: tm.subTaskId, dueOffsetDays: tm.dueOffsetDays })),
    });
    resolved.set(key, map);
    return map;
  }

  // Batch rows that land on the same date into one updateMany instead of one
  // query per row.
  const byDate = new Map<number, string[]>();
  for (const a of activities) {
    const next = datesFor(a.clientId, a.periodName)?.get(a.subTaskId);
    if (!next) continue;
    if (a.dueDate && a.dueDate.getTime() === next.getTime()) continue;
    const key = next.getTime();
    const list = byDate.get(key);
    if (list) list.push(a.id);
    else byDate.set(key, [a.id]);
  }
  if (byDate.size === 0) return 0;

  await prisma.$transaction(
    [...byDate].map(([time, ids]) =>
      prisma.clientActivity.updateMany({
        where: { id: { in: ids } },
        data: { dueDate: new Date(time) },
      })
    )
  );

  return [...byDate.values()].reduce((n, ids) => n + ids.length, 0);
}

function assertOffsetInRange(value: number) {
  if (value < MIN_OFFSET_DAYS || value > MAX_OFFSET_DAYS) {
    throw new Error(`Offset must be between ${MIN_OFFSET_DAYS} and ${MAX_OFFSET_DAYS} days.`);
  }
}

// The service-level rule, editable straight from the project page (the admin
// project form writes the same field through updateProject).
export async function setProjectDueRule(projectId: string, offsetDays: number) {
  await requireAdminAction();
  assertOffsetInRange(offsetDays);
  await prisma.project.update({
    where: { id: projectId },
    data: { dueOffsetDays: clampOffset(offsetDays) },
  });
  const updated = await recomputeDueDates({ projectId });
  revalidatePath("/");
  revalidatePath("/tasks");
  revalidatePath("/projects");
  revalidatePath(`/projects/${projectId}`);
  revalidatePath("/admin/projects");
  return { updated };
}

// A step's internal milestone, relative to the engagement's deadline.
// null clears it (the step shares the project's due date again).
export async function setChecklistTaskDueOffset(
  projectId: string,
  subTaskId: string,
  offsetDays: number | null
) {
  await requireAdminAction();
  if (offsetDays !== null) assertOffsetInRange(offsetDays);
  await prisma.projectTaskMap.update({
    where: { projectId_subTaskId: { projectId, subTaskId } },
    data: { dueOffsetDays: offsetDays === null ? null : clampOffset(offsetDays) },
  });
  const updated = await recomputeDueDates({ projectId });
  revalidatePath("/");
  revalidatePath("/tasks");
  revalidatePath(`/projects/${projectId}`);
  return { updated };
}

// One client's override of the service rule. null goes back to inheriting it.
export async function setAssignmentDueOffset(
  clientId: string,
  projectId: string,
  offsetDays: number | null
) {
  await requireEngagementAccess(clientId, projectId);
  if (offsetDays !== null) assertOffsetInRange(offsetDays);
  await prisma.projectClientMap.update({
    where: { clientId_projectId: { clientId, projectId } },
    data: { dueOffsetDays: offsetDays === null ? null : clampOffset(offsetDays) },
  });
  const updated = await recomputeDueDates({ projectId, clientId });
  revalidatePath("/");
  revalidatePath("/tasks");
  revalidatePath(`/assignments/${clientId}/${projectId}`);
  revalidatePath(`/clients/${clientId}`);
  return { updated };
}

// The escape hatch: a date typed onto one task. Flagged as overridden so a
// later rule change doesn't silently undo it. Passing null clears the override
// and hands the row back to the rules.
export async function setActivityDueDate(activityId: string, date: string | null) {
  const { user, activity } = await requireActivityAccess(activityId);

  if (date === null || date.trim() === "") {
    await prisma.clientActivity.update({
      where: { id: activityId },
      data: { dueDateOverridden: false },
    });
    await recomputeDueDates({ clientId: activity.clientId, projectId: activity.projectId });
  } else {
    // A yyyy-mm-dd string from a date input is parsed as UTC midnight by the
    // Date constructor, which lands on the previous day west of Greenwich.
    // Split it so the stored date is the day the user actually picked.
    const [y, m, d] = date.split("-").map(Number);
    if (!y || !m || !d) throw new Error("That date isn't valid.");
    await prisma.clientActivity.update({
      where: { id: activityId },
      data: { dueDate: new Date(y, m - 1, d), dueDateOverridden: true },
    });
  }

  await recordAudit({
    entityType: "ClientActivity",
    entityId: activityId,
    action: AUDIT.DUE_DATE_CHANGED,
    summary:
      date === null || date.trim() === ""
        ? "Cleared the manual due date — back on the service's rule"
        : `Due date set by hand to ${date}`,
    toValue: date || null,
    clientId: activity.clientId,
    projectId: activity.projectId,
    periodName: activity.periodName,
    actor: actorFrom(user),
  });

  revalidatePath("/");
  revalidatePath("/tasks");
  revalidatePath("/activity");
  revalidatePath(`/assignments/${activity.clientId}/${activity.projectId}`);
}

// --- Scheduled work generation ----------------------------------------------

// The admin "Run now" button. The same job the nightly cron runs, so pressing
// it is a real test of the schedule, not a separate code path.
export async function runPeriodGeneration() {
  await requireAdmin();
  const summary = await generatePeriods({ trigger: "manual" });
  revalidatePath("/");
  revalidatePath("/tasks");
  revalidatePath("/projects");
  revalidatePath("/admin/scheduler");
  return summary;
}

// --- Default assignees --------------------------------------------------------
//
// Two layers (see src/lib/default-assignees.ts): a step default expressing a
// role, and an engagement default expressing ownership of a client's work.
// Neither is retroactive — they apply to rows generated from here on. Pushing
// them onto an existing period is applyDefaultAssignees below, which is a
// deliberate, separate action because it changes live work.

export async function setStepDefaultAssignee(
  projectId: string,
  subTaskId: string,
  employeeId: string | null
) {
  const user = await requireAdminAction();
  await assertEmployeeExists(employeeId || null);
  const [taskMap, project] = await Promise.all([
    prisma.projectTaskMap.findUniqueOrThrow({
      where: { projectId_subTaskId: { projectId, subTaskId } },
      include: { subTask: true, defaultAssignee: true },
    }),
    prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { name: true } }),
  ]);

  const nextId = employeeId || null;
  if (taskMap.defaultAssigneeId === nextId) return;

  const updated = await prisma.projectTaskMap.update({
    where: { projectId_subTaskId: { projectId, subTaskId } },
    data: { defaultAssigneeId: nextId },
    include: { defaultAssignee: true },
  });

  await recordAudit({
    entityType: "ProjectTaskMap",
    entityId: `${projectId}:${subTaskId}`,
    action: AUDIT.DEFAULT_ASSIGNEE_CHANGED,
    summary: `${project.name} · ${taskMap.subTask.name}: default ${employeeName(
      taskMap.defaultAssignee
    )} → ${employeeName(updated.defaultAssignee)}`,
    fromValue: taskMap.defaultAssigneeId,
    toValue: nextId,
    projectId,
    contextLabel: project.name,
    actor: actorFrom(user),
  });

  revalidatePath(`/projects/${projectId}`);
  revalidatePath("/activity");
}

export async function setEngagementDefaultAssignee(
  clientId: string,
  projectId: string,
  employeeId: string | null
) {
  const user = await requireEngagementAccess(clientId, projectId);
  await assertEmployeeExists(employeeId || null);
  const assignment = await prisma.projectClientMap.findUniqueOrThrow({
    where: { clientId_projectId: { clientId, projectId } },
    include: { defaultAssignee: true, client: true, project: true },
  });

  const nextId = employeeId || null;
  if (assignment.defaultAssigneeId === nextId) return;

  const updated = await prisma.projectClientMap.update({
    where: { clientId_projectId: { clientId, projectId } },
    data: { defaultAssigneeId: nextId },
    include: { defaultAssignee: true },
  });

  await recordAudit({
    entityType: "ProjectClientMap",
    entityId: `${clientId}:${projectId}`,
    action: AUDIT.DEFAULT_ASSIGNEE_CHANGED,
    summary: `Engagement owner: ${employeeName(assignment.defaultAssignee)} → ${employeeName(
      updated.defaultAssignee
    )}`,
    fromValue: assignment.defaultAssigneeId,
    toValue: nextId,
    clientId,
    projectId,
    contextLabel: `${assignment.client.companyName} · ${assignment.project.name}`,
    actor: actorFrom(user),
  });

  revalidateAssignment(clientId, projectId);
  revalidatePath("/activity");
}

// Pushes the resolved defaults onto one period's rows. Only touches steps that
// are currently unassigned — silently reassigning work someone has already
// picked up would be a nasty surprise, and the bulk panel already exists for
// deliberate reassignment. Returns how many rows changed.
export async function applyDefaultAssignees(
  clientId: string,
  projectId: string,
  periodName: string
): Promise<number> {
  const user = await requireEngagementAccess(clientId, projectId);

  const [assignment, taskMaps, unassigned] = await Promise.all([
    prisma.projectClientMap.findUniqueOrThrow({
      where: { clientId_projectId: { clientId, projectId } },
      select: { defaultAssigneeId: true },
    }),
    prisma.projectTaskMap.findMany({
      where: { projectId },
      select: { subTaskId: true, defaultAssigneeId: true },
    }),
    prisma.clientActivity.findMany({
      where: { clientId, projectId, periodName, assigneeId: null },
      include: { subTask: { select: { name: true } } },
    }),
  ]);

  const defaults = resolveDefaultAssignees({
    steps: taskMaps,
    engagementDefaultId: assignment.defaultAssigneeId,
  });

  const updates = unassigned
    .map((a) => ({ activity: a, assigneeId: defaults.get(a.subTaskId) }))
    .filter((u): u is { activity: (typeof unassigned)[number]; assigneeId: string } =>
      Boolean(u.assigneeId)
    );
  if (updates.length === 0) return 0;

  // Group by assignee so this is a handful of updateManys, not one per row.
  const byAssignee = new Map<string, string[]>();
  for (const u of updates) {
    const list = byAssignee.get(u.assigneeId);
    if (list) list.push(u.activity.id);
    else byAssignee.set(u.assigneeId, [u.activity.id]);
  }
  await prisma.$transaction(
    [...byAssignee].map(([assigneeId, ids]) =>
      prisma.clientActivity.updateMany({ where: { id: { in: ids } }, data: { assigneeId } })
    )
  );

  const names = new Map(
    (
      await prisma.employee.findMany({ where: { id: { in: [...byAssignee.keys()] } } })
    ).map((e) => [e.id, `${e.firstName} ${e.lastName}`])
  );
  await recordAuditMany(
    updates.map((u) => ({
      entityType: "ClientActivity",
      entityId: u.activity.id,
      action: AUDIT.ASSIGNEE_CHANGED,
      summary: `${u.activity.subTask.name}: Unassigned → ${
        names.get(u.assigneeId) ?? "someone"
      } (from defaults)`,
      fromValue: null,
      toValue: u.assigneeId,
      clientId,
      projectId,
      periodName,
      actor: actorFrom(user),
    }))
  );

  revalidateAssignment(clientId, projectId);
  return updates.length;
}

// --- Estimates ----------------------------------------------------------------
//
// ClientActivity.estimatedMinutes is what turns the workload view from "how
// many tasks is this person carrying" into "how many hours". It follows the
// same two-layer, non-retroactive shape as the due-date rules and the default
// assignees, because inconsistency between those three would be its own bug:
//
//   ProjectTaskMap.estimatedMinutes  — the template's estimate for a step
//   ClientActivity.estimatedMinutes  — this task's estimate, seeded from the
//                                      template and then editable
//
// Changing the template does NOT rewrite existing rows. Unlike a due date, an
// estimate is frequently corrected against the specific client in front of you
// ("Bluepoint's data entry always takes three times as long"), so silently
// overwriting those corrections when somebody tidies a template would destroy
// the more accurate number.

// A whole working day. An estimate longer than this is a project, not a step,
// and treating it as one step would make every capacity bar meaningless.
const MAX_ESTIMATE_MINUTES = 24 * 60;

function clampEstimate(minutes: number | null): number | null {
  if (minutes === null) return null;
  const rounded = Math.round(minutes);
  if (!Number.isFinite(rounded) || rounded <= 0) return null;
  if (rounded > MAX_ESTIMATE_MINUTES) {
    throw new Error("An estimate for a single step can't exceed 24 hours.");
  }
  return rounded;
}

// The template layer, edited from the checklist builder on /projects/[id].
export async function setChecklistTaskEstimate(
  projectId: string,
  subTaskId: string,
  minutes: number | null
) {
  const user = await requireAdminAction();
  const value = clampEstimate(minutes);

  const [taskMap, project] = await Promise.all([
    prisma.projectTaskMap.findUniqueOrThrow({
      where: { projectId_subTaskId: { projectId, subTaskId } },
      include: { subTask: { select: { name: true } } },
    }),
    prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { name: true } }),
  ]);
  if (taskMap.estimatedMinutes === value) return;

  await prisma.projectTaskMap.update({
    where: { projectId_subTaskId: { projectId, subTaskId } },
    data: { estimatedMinutes: value },
  });

  await recordAudit({
    entityType: "ProjectTaskMap",
    entityId: `${projectId}:${subTaskId}`,
    action: AUDIT.ESTIMATE_CHANGED,
    summary: `${project.name} · ${taskMap.subTask.name}: estimate ${
      taskMap.estimatedMinutes ? formatMinutes(taskMap.estimatedMinutes) : "unset"
    } → ${value ? formatMinutes(value) : "unset"} (applies to tasks generated from now on)`,
    fromValue: taskMap.estimatedMinutes === null ? null : String(taskMap.estimatedMinutes),
    toValue: value === null ? null : String(value),
    projectId,
    contextLabel: project.name,
    actor: actorFrom(user),
  });

  revalidatePath(`/projects/${projectId}`);
  revalidatePath("/workload");
}

// The per-task layer, edited inline on the assignment checklist.
export async function setActivityEstimate(activityId: string, minutes: number | null) {
  const { user } = await requireActivityAccess(activityId);
  const value = clampEstimate(minutes);

  const before = await prisma.clientActivity.findUniqueOrThrow({
    where: { id: activityId },
    include: {
      subTask: { select: { name: true } },
      client: { select: { companyName: true } },
      project: { select: { name: true } },
    },
  });
  if (before.estimatedMinutes === value) return;

  await prisma.clientActivity.update({
    where: { id: activityId },
    data: { estimatedMinutes: value },
  });

  await recordAudit({
    entityType: "ClientActivity",
    entityId: activityId,
    action: AUDIT.ESTIMATE_CHANGED,
    summary: `${before.subTask.name}: estimate ${
      before.estimatedMinutes ? formatMinutes(before.estimatedMinutes) : "unset"
    } → ${value ? formatMinutes(value) : "unset"}`,
    fromValue: before.estimatedMinutes === null ? null : String(before.estimatedMinutes),
    toValue: value === null ? null : String(value),
    clientId: before.clientId,
    projectId: before.projectId,
    periodName: before.periodName,
    contextLabel: `${before.client.companyName} · ${before.project.name}`,
    actor: actorFrom(user),
  });

  revalidateAssignment(before.clientId, before.projectId);
  revalidatePath("/workload");
  revalidatePath("/tasks");
}
