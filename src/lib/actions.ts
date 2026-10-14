"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { canMarkDone } from "@/lib/workflow";
import { getRecurring, isPeriodBefore, resolvePeriod } from "@/lib/periods";
import {
  checkAnchor,
  currentPeriodName,
  effectiveAnchor,
  firstPeriodName,
  formatPeriodName,
  isoDate,
  nextPeriodName,
  parsePeriodName,
  usesAnchor,
} from "@/lib/period-names";
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
import { objectStore } from "@/lib/storage";
import { storeDocumentBytes } from "@/lib/document-vault";
import { checkUpload, checkContent } from "@/lib/file-safety";
import { decryptField } from "@/lib/encryption";
import { maskSsn, maskTaxId, protectSsn, protectTaxId } from "@/lib/sensitive-fields";
import { rateLimit } from "@/lib/rate-limit";
import { requireAdmin } from "@/lib/auth";
import { normalizeChecklist } from "@/lib/checklist";
import {
  parseInstance,
  cleanEngagementName,
  engagementHref,
  engagementId,
  engagementKeyString,
  engagementLabel,
  engagementWhere,
  nextInstance,
} from "@/lib/engagements";
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
        instance: activity.instance,
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
    instance: activity.instance,
    periodName: activity.periodName,
    contextLabel: `${activity.client.companyName} · ${activity.project.name}`,
    actor: actorFrom(user),
  });

  revalidatePath("/");
  revalidatePath("/tasks");
  revalidatePath("/activity");
  revalidatePath(`/assignments/${activity.clientId}/${activity.projectId}`);

  if (newStatus === "DONE") {
    await maybeRollPeriodForward(activity.clientId, activity.projectId, activity.periodName, activity.instance);
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
  // Write-only. A new tax ID to store (encrypted); blank leaves the current
  // one untouched, because the form never receives the current value.
  taxId?: string;
  clearTaxId?: boolean;
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
    ...taxIdChanges(data),
    email: data.email?.trim() || null,
    note: data.note?.trim() || null,
    coRegDate: data.coRegDate ? new Date(data.coRegDate) : null,
    coRegState: data.coRegState?.trim() || null,
    renewMonth: data.renewMonth?.trim() || null,
  };
}

// The tax ID columns to write, if any. Nothing when the field was left blank —
// the form can't prefill a value it's never sent, so blank means "keep".
function taxIdChanges(data: ClientFormInput) {
  const raw = data.taxId?.trim();
  if (raw) return protectTaxId(raw);
  if (data.clearTaxId) return { taxIdEncrypted: null, taxIdLast4: null, taxIdIndex: null };
  return {};
}

// What goes back to the browser after a save. Never the row itself: that
// would ship ciphertext and index values to the client for no reason.
function clientSummary(client: { id: string; companyName: string }) {
  return { id: client.id, companyName: client.companyName };
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
    if (values.taxIdEncrypted) {
      await recordAudit({
        entityType: "Client",
        entityId: client.id,
        action: AUDIT.SENSITIVE_CHANGED,
        summary: `Set ${client.companyName}'s tax ID (${maskTaxId(values.taxIdLast4)})`,
        clientId: client.id,
        contextLabel: client.companyName,
      });
    }
    revalidatePath("/clients");
    revalidatePath("/activity");
    return clientSummary(client);
  } catch (err) {
    rethrowFriendly(err, { unique: "That Tax ID is already in use by another client." });
  }
}

export async function updateClient(clientId: string, data: ClientFormInput) {
  await requireClientAccess(clientId);
  const values = normalizeClientInput(data);
  const taxIdChanged = "taxIdEncrypted" in values;
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
    if (taxIdChanged) {
      await recordAudit({
        entityType: "Client",
        entityId: clientId,
        action: AUDIT.SENSITIVE_CHANGED,
        summary: values.taxIdEncrypted
          ? `Changed ${client.companyName}'s tax ID (now ${maskTaxId(values.taxIdLast4)})`
          : `Removed ${client.companyName}'s tax ID`,
        clientId,
        contextLabel: client.companyName,
      });
    }
    revalidatePath("/clients");
    revalidatePath(`/clients/${clientId}`);
    revalidatePath("/activity");
    return clientSummary(client);
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
    const today = currentPeriodName(
      type,
      new Date(),
      effectiveAnchor(e.project.recurrenceAnchor, e.recurrenceAnchor)
    );
    if (!e.currentPeriod || !isPeriodBefore(type, e.currentPeriod, today)) continue;
    await openPeriodForAssignment({
      clientId,
      projectId: e.projectId,
      instance: e.instance,
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
      where: engagementId(e),
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
// omitted, it's derived from the project's cadence relative to today (or its
// start date), creating that period if needed.
//
// This creates the client's FIRST engagement of the project. A second,
// independent one ("Bookkeeping 2") is addProjectCopy below.
export async function assignProjectToClient(
  clientId: string,
  projectId: string,
  periodName?: string
) {
  const user = await requireAdminAction();
  const existing = await prisma.projectClientMap.count({ where: { clientId, projectId } });
  if (existing > 0) {
    throw new Error(
      "This client already has this project. Use \"Add another\" on the client's page to run a second, separate copy."
    );
  }
  return createEngagement({ clientId, projectId, instance: 1, name: null, periodName, actor: actorFrom(user) });
}

// Another copy of a project the client already has, running completely
// independently: its own checklist rows, periods, owner, due-date override,
// start date, notes and files. `name` is what it's called on screen
// ("Bookkeeping 2", "Bookkeeping — Holding LLC"); blank = "<project> <n>".
export async function addProjectCopy(clientId: string, projectId: string, name?: string) {
  const user = await requireAdminAction();
  const cleanName = cleanEngagementName(name);
  const existing = await prisma.projectClientMap.findMany({
    where: { clientId, projectId },
    select: { instance: true },
  });
  const instance = nextInstance(existing.map((e) => e.instance));
  return createEngagement({ clientId, projectId, instance, name: cleanName, actor: actorFrom(user) });
}

// Renames one engagement. Blank goes back to the default name.
export async function renameEngagement(clientId: string, projectId: string, instance: number, name: string) {
  const user = await requireEngagementAccess(clientId, projectId, instance);
  const cleanName = cleanEngagementName(name);
  const engagement = await prisma.projectClientMap.findUniqueOrThrow({
    where: engagementId({ clientId, projectId, instance }),
    include: { project: { select: { name: true } }, client: { select: { companyName: true } } },
  });
  await prisma.projectClientMap.update({
    where: engagementId({ clientId, projectId, instance }),
    data: { name: cleanName },
  });
  const before = engagementLabel(engagement.project.name, engagement.name, instance);
  const after = engagementLabel(engagement.project.name, cleanName, instance);
  await recordAudit({
    entityType: "ProjectClientMap",
    entityId: engagementKeyString({ clientId, projectId, instance }),
    action: AUDIT.ENGAGEMENT_RENAMED,
    summary: `${engagement.client.companyName}: "${before}" renamed to "${after}"`,
    fromValue: before,
    toValue: after,
    clientId,
    projectId,
    instance,
    contextLabel: `${engagement.client.companyName} · ${after}`,
    actor: actorFrom(user),
  });
  revalidateAssignment(clientId, projectId);
  revalidatePath("/tasks");
  revalidatePath(`/projects/${projectId}`);
}

async function createEngagement(input: {
  clientId: string;
  projectId: string;
  instance: number;
  name: string | null;
  periodName?: string;
  actor: { id: string; label: string };
}) {
  const { clientId, projectId, instance } = input;
  const taskMaps = await prisma.projectTaskMap.count({ where: { projectId } });
  if (taskMaps === 0) {
    throw new Error("This project has no checklist steps defined yet.");
  }

  const project = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    include: { recurring: true },
  });
  let periodName = input.periodName;
  if (!periodName) {
    // Today's period on the project's schedule — or, when its start date is
    // still in the future, the period that begins on that date.
    periodName = firstPeriodName(project.recurring.type, new Date(), project.recurrenceAnchor);
    await resolvePeriod(project.recurringId, project.recurring.type, periodName);
  }

  await prisma.projectClientMap.create({
    data: {
      clientId,
      projectId,
      instance,
      name: input.name,
      active: true,
      createSubtask: true,
      currentPeriod: periodName,
      startDate: new Date(),
    },
  });

  // Generated through the shared helper so due dates and assignees are
  // resolved exactly the way the nightly job resolves them. If this throws
  // after the assignment row lands, the engagement exists with no task rows —
  // which is exactly the state the scheduler repairs on its next run.
  await openPeriodForAssignment({
    clientId,
    projectId,
    instance,
    periodName,
    project: {
      recurringId: project.recurringId,
      recurring: { type: project.recurring.type },
      dueOffsetDays: project.dueOffsetDays,
    },
    clientOverride: null,
    // A brand-new engagement has no owner of its own, so the project's owner
    // (if any) picks up every step.
    engagementDefaultAssigneeId: null,
    projectOwnerId: project.ownerId,
    actor: input.actor,
  });

  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { companyName: true },
  });
  const label = engagementLabel(project.name, input.name, instance);
  await recordAudit({
    entityType: "ProjectClientMap",
    entityId: engagementKeyString({ clientId, projectId, instance }),
    action: AUDIT.ENGAGEMENT_CREATED,
    summary: `${client?.companyName ?? "Client"} added to ${label} (${formatPeriodName(periodName)})`,
    toValue: periodName,
    clientId,
    projectId,
    instance,
    periodName,
    contextLabel: `${client?.companyName ?? "Client"} · ${label}`,
    actor: input.actor,
  });

  revalidatePath("/");
  revalidatePath("/tasks");
  revalidatePath("/projects");
  revalidatePath(`/projects/${projectId}`);
  revalidatePath(`/clients/${clientId}`);
  revalidatePath("/activity");
  return { instance, href: engagementHref({ clientId, projectId, instance }) };
}

// --- Running two periods at once ----------------------------------------------
//
// Opens the engagement's next period now: November's bookkeeping can begin
// while October's review is still being finished. The earlier period stays
// open on the dashboard, the Tasks list and the engagement page until its last
// step is done; each period keeps its own checklist, files and due date.
//
// Only one period ahead of the calendar: you can start next month's work
// during this month, not three months out.
export async function startNextPeriod(clientId: string, projectId: string, instance: number = 1) {
  const user = await requireEngagementAccess(clientId, projectId, instance);
  const key = { clientId, projectId, instance };
  const engagement = await prisma.projectClientMap.findUniqueOrThrow({
    where: engagementId(key),
    include: { project: { include: { recurring: true } }, client: { select: { companyName: true, archivedAt: true } } },
  });
  const type = engagement.project.recurring.type;
  if (type === "ONE_TIME") throw new Error("A one-time project doesn't have a next period.");
  if (!engagement.active || engagement.client.archivedAt) throw new Error("This engagement isn't active.");
  if (!engagement.currentPeriod) throw new Error("This engagement has no current period yet.");

  const current = parsePeriodName(engagement.currentPeriod);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (current.start.getTime() > today.getTime()) {
    throw new Error(
      `${formatPeriodName(engagement.currentPeriod)} hasn't started yet, so the period after it can't be opened.`
    );
  }

  const next = nextPeriodName(
    type,
    engagement.currentPeriod,
    effectiveAnchor(engagement.project.recurrenceAnchor, engagement.recurrenceAnchor)
  );
  if (!next) throw new Error("This project doesn't have a next period.");

  const result = await openPeriodForAssignment({
    clientId,
    projectId,
    instance,
    periodName: next,
    project: {
      recurringId: engagement.project.recurringId,
      recurring: { type },
      dueOffsetDays: engagement.project.dueOffsetDays,
    },
    clientOverride: engagement.dueOffsetDays,
    engagementDefaultAssigneeId: engagement.defaultAssigneeId,
    projectOwnerId: engagement.project.ownerId,
    actor: actorFrom(user),
  });
  await prisma.projectClientMap.update({
    where: engagementId(key),
    data: { currentPeriod: next },
  });

  revalidateAssignment(clientId, projectId);
  revalidatePath("/");
  revalidatePath("/tasks");
  return { periodName: next, tasks: result.activitiesCreated };
}

// --- Client contacts --------------------------------------------------------
//
// CorpContact create/edit/delete. The SSN is write-only from the browser's
// side: a new value is encrypted here (src/lib/sensitive-fields.ts), blank
// keeps the stored one, and nothing ever sends the stored value back except
// revealContactSsn, which is audited.

export type ContactInput = {
  firstName?: string;
  lastName?: string;
  mobile?: string;
  email?: string;
  note?: string;
  ssn?: string;
  clearSsn?: boolean;
};

type ContactWrite = {
  firstName: string | null;
  lastName: string | null;
  mobile: string | null;
  email: string | null;
  note: string | null;
  ssnEncrypted?: string | null;
  ssnLast4?: string | null;
};

function normalizeContactInput(data: ContactInput): ContactWrite {
  const values: ContactWrite = {
    firstName: data.firstName?.trim() || null,
    lastName: data.lastName?.trim() || null,
    mobile: data.mobile?.trim() || null,
    email: data.email?.trim() || null,
    note: data.note?.trim() || null,
  };
  if (!values.firstName && !values.lastName && !values.email && !values.mobile) {
    throw new Error("A contact needs at least a name, email, or mobile number.");
  }
  const ssn = data.ssn?.trim();
  if (ssn) return { ...values, ...protectSsn(ssn) };
  if (data.clearSsn) return { ...values, ssnEncrypted: null, ssnLast4: null };
  return values;
}

function contactSummary(c: { id: string; clientId: string; ssnLast4: string | null }) {
  return { id: c.id, clientId: c.clientId, ssnMasked: maskSsn(c.ssnLast4) };
}

function contactName(c: { firstName: string | null; lastName: string | null; email: string | null }) {
  return [c.firstName, c.lastName].filter(Boolean).join(" ") || c.email || "a contact";
}

async function auditSsnChange(
  contact: { id: string; clientId: string; firstName: string | null; lastName: string | null; email: string | null },
  values: { ssnEncrypted?: string | null; ssnLast4?: string | null }
) {
  if (!("ssnEncrypted" in values)) return;
  await recordAudit({
    entityType: "CorpContact",
    entityId: contact.id,
    action: AUDIT.SENSITIVE_CHANGED,
    summary: values.ssnEncrypted
      ? `Set the SSN for ${contactName(contact)} (${maskSsn(values.ssnLast4)})`
      : `Removed the SSN for ${contactName(contact)}`,
    clientId: contact.clientId,
  });
}

export async function createContact(clientId: string, data: ContactInput) {
  await requireClientAccess(clientId);
  const values = normalizeContactInput(data);
  const contact = await prisma.corpContact.create({ data: { clientId, ...values } });
  await auditSsnChange(contact, values);
  revalidatePath(`/clients/${clientId}`);
  revalidatePath("/reports/client-information-list");
  return contactSummary(contact);
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
  await auditSsnChange(contact, values);
  revalidatePath(`/clients/${contact.clientId}`);
  return contactSummary(contact);
}

export async function deleteContact(contactId: string) {
  await requireContactAccess(contactId);
  const contact = await prisma.corpContact.delete({ where: { id: contactId } });
  revalidatePath(`/clients/${contact.clientId}`);
}

// --- Revealing a full tax ID / SSN ---------------------------------------------
//
// The only two ways a full number leaves the server. Anyone who can open the
// client may reveal, but every reveal is an audit row naming who and when, and
// reveals are rate limited so a compromised account can't walk the client
// list pulling every SSN — 30 in 10 minutes is far above real use.

const REVEAL_LIMIT = { limit: 30, windowMs: 10 * 60_000 };

function checkRevealLimit(userId: string) {
  const limit = rateLimit(`reveal:${userId}`, REVEAL_LIMIT);
  if (!limit.ok) {
    throw new Error(`Too many sensitive values viewed in a short time. Try again in ${limit.retryAfterSeconds}s.`);
  }
}

export async function revealClientTaxId(clientId: string): Promise<string> {
  const user = await requireClientAccess(clientId);
  checkRevealLimit(user.id);
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { companyName: true, taxIdEncrypted: true, taxIdLast4: true },
  });
  if (!client?.taxIdEncrypted) throw new Error("This client has no tax ID on file.");
  const value = decryptField(client.taxIdEncrypted, "Client.taxId");
  await recordAudit({
    entityType: "Client",
    entityId: clientId,
    action: AUDIT.SENSITIVE_REVEALED,
    summary: `Viewed ${client.companyName}'s full tax ID (${maskTaxId(client.taxIdLast4)})`,
    clientId,
    contextLabel: client.companyName,
    actor: actorFrom(user),
  });
  return value;
}

export async function revealContactSsn(contactId: string): Promise<string> {
  const existing = await prisma.corpContact.findUnique({
    where: { id: contactId },
    select: { clientId: true },
  });
  if (!existing) throw new Error("That contact no longer exists.");
  const user = await requireClientAccess(existing.clientId);
  checkRevealLimit(user.id);
  const contact = await prisma.corpContact.findUnique({
    where: { id: contactId },
    include: { client: { select: { companyName: true } } },
  });
  if (!contact?.ssnEncrypted) throw new Error("This contact has no SSN on file.");
  const value = decryptField(contact.ssnEncrypted, "CorpContact.ssn");
  await recordAudit({
    entityType: "CorpContact",
    entityId: contactId,
    action: AUDIT.SENSITIVE_REVEALED,
    summary: `Viewed the full SSN for ${contactName(contact)} (${maskSsn(contact.ssnLast4)})`,
    clientId: contact.clientId,
    contextLabel: contact.client.companyName,
    actor: actorFrom(user),
  });
  return value;
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

// --- Projects an employee handles ---------------------------------------------
//
// Project.ownerId: "this person does our bookkeeping". Every engagement of the
// project is pre-assigned to them, step by step, unless the engagement has its
// own owner or a step names a specialist (src/lib/default-assignees.ts). A
// project has one owner, so ticking a project here takes it over from whoever
// had it.
//
// Taking a project on also fills in that project's open tasks that nobody is
// assigned to yet. It never reassigns a task someone already has.

export async function setEmployeeProjects(employeeId: string, projectIds: string[]) {
  const user = await requireAdminAction();
  const employee = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: { id: true, firstName: true, lastName: true },
  });
  if (!employee) throw new Error("That employee no longer exists.");

  const wanted = new Set(projectIds);
  const projects = await prisma.project.findMany({
    select: { id: true, name: true, ownerId: true, owner: { select: { firstName: true, lastName: true } } },
  });
  const known = new Set(projects.map((p) => p.id));
  for (const id of wanted) if (!known.has(id)) throw new Error("One of those projects no longer exists.");

  const gained = projects.filter((p) => wanted.has(p.id) && p.ownerId !== employeeId);
  const released = projects.filter((p) => !wanted.has(p.id) && p.ownerId === employeeId);
  const name = employeeName(employee);

  await prisma.$transaction([
    ...gained.map((p) => prisma.project.update({ where: { id: p.id }, data: { ownerId: employeeId } })),
    ...released.map((p) => prisma.project.update({ where: { id: p.id }, data: { ownerId: null } })),
  ]);

  // Fill the blanks on work already open for the projects just taken on: rows
  // with no assignee, not done, whose step and engagement don't name anyone
  // else (those would win over the project owner anyway).
  let filled = 0;
  if (gained.length > 0) {
    const gainedIds = gained.map((p) => p.id);
    const [stepDefaults, engagementDefaults, blanks] = await Promise.all([
      prisma.projectTaskMap.findMany({
        where: { projectId: { in: gainedIds }, defaultAssigneeId: { not: null } },
        select: { projectId: true, subTaskId: true },
      }),
      prisma.projectClientMap.findMany({
        where: { projectId: { in: gainedIds }, defaultAssigneeId: { not: null } },
        select: { projectId: true, clientId: true, instance: true },
      }),
      prisma.clientActivity.findMany({
        where: {
          projectId: { in: gainedIds },
          assigneeId: null,
          status: { not: "DONE" },
          client: { archivedAt: null },
        },
        select: { id: true, projectId: true, clientId: true, instance: true, subTaskId: true },
      }),
    ]);
    const stepTaken = new Set(stepDefaults.map((d) => `${d.projectId}:${d.subTaskId}`));
    const engagementTaken = new Set(engagementDefaults.map((d) => engagementKeyString(d)));
    const ids = blanks
      .filter(
        (a) =>
          !stepTaken.has(`${a.projectId}:${a.subTaskId}`) &&
          !engagementTaken.has(engagementKeyString(a))
      )
      .map((a) => a.id);
    if (ids.length > 0) {
      const res = await prisma.clientActivity.updateMany({
        where: { id: { in: ids } },
        data: { assigneeId: employeeId },
      });
      filled = res.count;
    }
  }

  await recordAuditMany([
    ...gained.map((p) => ({
      entityType: "Project",
      entityId: p.id,
      action: AUDIT.PROJECT_OWNER_CHANGED,
      summary: `${p.name} is now handled by ${name}${p.owner ? ` (was ${employeeName(p.owner)})` : ""}`,
      fromValue: p.ownerId,
      toValue: employeeId,
      actor: actorFrom(user),
    })),
    ...released.map((p) => ({
      entityType: "Project",
      entityId: p.id,
      action: AUDIT.PROJECT_OWNER_CHANGED,
      summary: `${p.name} no longer has a default owner (was ${name})`,
      fromValue: employeeId,
      toValue: null,
      actor: actorFrom(user),
    })),
  ]);

  revalidatePath(`/admin/employees/${employeeId}/edit`);
  revalidatePath("/admin/employees");
  revalidatePath("/projects");
  revalidatePath("/");
  revalidatePath("/tasks");
  return { gained: gained.length, released: released.length, filled };
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
        // A re-invited person starts clean: their old authenticator entry
        // shouldn't be what stands between them and a fresh account.
        totpSecret: null,
        totpEnabledAt: null,
        totpLastUsedStep: null,
        recoveryCodeHashes: null,
      },
    }),
    prisma.loginChallenge.deleteMany({ where: { employeeId } }),
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
  // The date the periods line up to, as yyyy-mm-dd. "" or omitted = the
  // calendar default. See src/lib/period-names.ts.
  recurrenceAnchor?: string | null;
};

// A start date from a form, validated for the cadence. null = calendar default.
// One-time and semi-monthly projects have fixed periods, so any date is dropped.
function parseAnchorInput(raw: string | null | undefined, type: RecurringType): Date | null {
  const text = (raw ?? "").trim();
  if (!text || !usesAnchor(type)) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) throw new Error("Enter the start date as a full date.");
  const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const check = checkAnchor(type, date);
  if (!check.ok) throw new Error(check.reason);
  return date;
}

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
        recurrenceAnchor: parseAnchorInput(data.recurrenceAnchor, data.recurring),
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
        recurrenceAnchor: parseAnchorInput(data.recurrenceAnchor, data.recurring),
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

// `position` is the step number it should become (1 = first). Steps from that
// number on move down one.
export async function addProjectTaskMap(
  projectId: string,
  subTaskId: string,
  position: number
) {
  const user = await requireAdmin();
  const existing = await prisma.projectTaskMap.findUnique({
    where: { projectId_subTaskId: { projectId, subTaskId } },
  });
  if (existing) {
    throw new Error("That task is already on this project's checklist.");
  }
  await prisma.projectTaskMap.create({ data: { projectId, subTaskId, sequence: 0 } });
  await normalizeChecklist(projectId, {
    insert: { id: subTaskId, position },
    actor: actorFrom(user),
  });
  revalidateProjectBuilder(projectId);
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
  await normalizeChecklist(projectId);
  revalidateProjectBuilder(projectId);
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
// Ordering: steps are numbered 1, 2, 3… and every change goes through
// normalizeChecklist (src/lib/checklist.ts), which renumbers the periods
// still in progress to match. Finished periods keep the numbers they were done under.

function revalidateProjectBuilder(projectId: string) {
  revalidatePath("/projects");
  revalidatePath(`/projects/${projectId}`);
  revalidatePath("/admin/projects");
  revalidatePath("/admin/projects-task");
  revalidatePath("/admin/projects-task-map");
  revalidatePath("/clients/new");
  revalidatePath("/reports/project-task-compare");
}

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
        recurrenceAnchor: parseAnchorInput(data.recurrenceAnchor, data.recurring),
      },
    });
    revalidateProjectBuilder(project.id);
    return { id: project.id };
  } catch (err) {
    rethrowFriendly(err, { unique: "A project with that name already exists." });
  }
}

// Adds a step. `position` is the number it should become — insert between
// steps 4 and 5 by passing 5, and the old 5 onward each move down one.
// Omitted = the end of the list.
//
// Periods already under way get the new step too, unless their work is
// already past that point (adding an open step in front of finished ones
// would break the finish-in-order rule).
export async function addChecklistTask(projectId: string, name: string, position?: number) {
  const user = await requireAdminAction();
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Task name is required.");
  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });

  const created = await prisma.projectSubTask.create({
    data: { name: trimmed, taskMaps: { create: { projectId, sequence: 0 } } },
  });
  const steps = await prisma.projectTaskMap.count({
    where: { projectId, NOT: { subTaskId: created.id } },
  });
  const at = position && Number.isFinite(position) ? Math.max(1, Math.min(steps + 1, Math.trunc(position))) : steps + 1;
  const result = await normalizeChecklist(projectId, {
    insert: { id: created.id, position: at },
    actor: actorFrom(user),
  });
  await recordAudit({
    entityType: "Project",
    entityId: projectId,
    action: AUDIT.CHECKLIST_CHANGED,
    summary:
      `Added step ${at} "${trimmed}" to ${project.name}` +
      (result.addedToOpenPeriods > 0
        ? ` — also added to ${result.addedToOpenPeriods} period${result.addedToOpenPeriods === 1 ? "" : "s"} in progress`
        : ""),
    actor: actorFrom(user),
  });
  revalidateProjectBuilder(projectId);
  revalidatePath("/");
  revalidatePath("/tasks");
  return { subTaskId: created.id, position: at, ...result };
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

  const orphaned =
    (await prisma.projectTaskMap.count({ where: { subTaskId, NOT: { projectId } } })) === 0 &&
    (await prisma.clientActivity.count({ where: { subTaskId } })) === 0;

  await prisma.$transaction([
    prisma.projectTaskMap.delete({ where: { projectId_subTaskId: { projectId, subTaskId } } }),
    // A task created for this project only would otherwise linger in the
    // master list forever; drop it when nothing else references it.
    ...(orphaned ? [prisma.projectSubTask.delete({ where: { id: subTaskId } })] : []),
  ]);
  // Closes the gap so the numbering stays 1, 2, 3…
  await normalizeChecklist(projectId);
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

  await normalizeChecklist(projectId, { orderedIds: orderedSubTaskIds });
  revalidateProjectBuilder(projectId);
  revalidatePath("/");
  revalidatePath("/tasks");
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
    instance: updated.instance,
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
  target: BulkAssignTarget,
  instance: number = 1
): Promise<number> {
  const user = await requireEngagementAccess(clientId, projectId, instance);
  const assigneeId = employeeId || null;
  await assertEmployeeExists(assigneeId);
  const base = { clientId, projectId, instance, periodName };

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
      instance,
      periodName,
      actor: actorFrom(user),
    }))
  );

  revalidateAssignment(clientId, projectId);
  return result.count;
}

// --- Client notes ------------------------------------------------------------
//
// Notes about the client as a whole ("prefers calls to email", "selling the
// business in March"), not one project or task. Anyone who can open the client
// can read and add them; only the author or an admin can edit or remove one.

const MAX_NOTE_LENGTH = 10_000;

function cleanNoteBody(raw: string): string {
  const body = raw.trim();
  if (!body) throw new Error("Note can't be empty.");
  if (body.length > MAX_NOTE_LENGTH) throw new Error("That note is too long — split it into a few notes.");
  return body;
}

export async function addClientNote(clientId: string, data: { body: string }) {
  const user = await requireClientAccess(clientId);
  const body = cleanNoteBody(data.body);
  const note = await prisma.clientNote.create({ data: { clientId, body, authorId: user.id } });
  await recordAudit({
    entityType: "ClientNote",
    entityId: note.id,
    action: AUDIT.CLIENT_NOTE_ADDED,
    summary: `Added a client note: "${body.length > 80 ? `${body.slice(0, 77)}…` : body}"`,
    clientId,
    actor: actorFrom(user),
  });
  revalidatePath(`/clients/${clientId}`);
  return { id: note.id };
}

async function requireClientNoteOwnership(id: string) {
  const note = await prisma.clientNote.findUnique({
    where: { id },
    select: { clientId: true, authorId: true },
  });
  if (!note) throw new Error("That note no longer exists.");
  const user = await requireClientAccess(note.clientId);
  if (user.role !== "ADMIN" && note.authorId !== user.id) {
    throw new Error("Only the person who wrote a note (or an admin) can change it.");
  }
  return { user, clientId: note.clientId };
}

export async function updateClientNote(id: string, data: { body: string }) {
  const { user, clientId } = await requireClientNoteOwnership(id);
  const body = cleanNoteBody(data.body);
  await prisma.clientNote.update({ where: { id }, data: { body } });
  await recordAudit({
    entityType: "ClientNote",
    entityId: id,
    action: AUDIT.CLIENT_NOTE_CHANGED,
    summary: "Edited a client note",
    clientId,
    actor: actorFrom(user),
  });
  revalidatePath(`/clients/${clientId}`);
}

export async function deleteClientNote(id: string) {
  const { user, clientId } = await requireClientNoteOwnership(id);
  await prisma.clientNote.delete({ where: { id } });
  await recordAudit({
    entityType: "ClientNote",
    entityId: id,
    action: AUDIT.CLIENT_NOTE_DELETED,
    summary: "Removed a client note",
    clientId,
    actor: actorFrom(user),
  });
  revalidatePath(`/clients/${clientId}`);
}

export async function addAssignmentNote(
  clientId: string,
  projectId: string,
  data: { body: string; authorId?: string },
  instance: number = 1
) {
  const user = await requireEngagementAccess(clientId, projectId, instance);
  const body = data.body.trim();
  if (!body) throw new Error("Note can't be empty.");
  // The author is whoever is signed in. It used to be taken from the request,
  // which let anyone post a note under a colleague's name.
  const created = await prisma.assignmentNote.create({
    data: { clientId, projectId, instance, body, authorId: user.id },
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
    select: { clientId: true, projectId: true, instance: true, authorId: true },
  });
  if (!note) throw new Error("That note no longer exists.");
  const user = await requireEngagementAccess(note.clientId, note.projectId, note.instance);
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

// Files tab. Every upload is checked (allow-listed type, and bytes that match
// it — src/lib/file-safety.ts), then encrypted with its own key before it goes
// to storage (src/lib/document-vault.ts). The row id is generated up front
// because it's bound into the ciphertext, and the bytes are written before the
// row so a failure can never leave a Document pointing at nothing.
export async function uploadDocument(formData: FormData) {
  const clientId = String(formData.get("clientId") ?? "");
  const projectId = String(formData.get("projectId") ?? "");
  const instance = parseInstance(String(formData.get("instance") ?? "1"));
  const periodName = String(formData.get("periodName") ?? "") || null;
  const file = formData.get("file");

  if (!clientId || !projectId) throw new Error("Missing engagement reference.");
  const user = await requireEngagementAccess(clientId, projectId, instance);
  // Recorded from the session, not the form — see addAssignmentNote.
  const uploadedById = user.id;
  if (!(file instanceof File) || file.size === 0) {
    throw new Error("Choose a file to upload.");
  }

  const named = checkUpload({ name: file.name, size: file.size });
  if (!named.ok) throw new Error(named.reason);
  const bytes = Buffer.from(await file.arrayBuffer());
  const verdict = checkContent(named.filename, bytes);
  if (!verdict.ok) {
    await recordAudit({
      entityType: "Document",
      entityId: "rejected",
      action: AUDIT.DOCUMENT_REJECTED,
      summary: `Refused an upload named "${named.filename}": ${verdict.reason}`,
      clientId,
      projectId,
      instance,
      periodName,
      actor: actorFrom(user),
    });
    throw new Error(verdict.reason);
  }

  const id = randomUUID();
  const stored = await storeDocumentBytes({ documentId: id, clientId, bytes });
  try {
    await prisma.document.create({
      data: {
        id,
        clientId,
        projectId,
        instance,
        periodName,
        uploadedById,
        filename: verdict.filename,
        mimeType: verdict.mimeType,
        size: bytes.length,
        ...stored,
      },
    });
  } catch (err) {
    await objectStore.remove(stored.bucket, stored.storageKey).catch(() => {});
    rethrowFriendly(err, { foreignKey: "That client or project no longer exists." });
  }

  await recordAudit({
    entityType: "Document",
    entityId: id,
    action: AUDIT.DOCUMENT_UPLOADED,
    summary: `Uploaded "${verdict.filename}"`,
    clientId,
    projectId,
    instance,
    periodName,
    actor: actorFrom(user),
  });
  revalidateAssignment(clientId, projectId);
}

// The row goes first: it holds the file's only wrapped key, so once it's gone
// the object is unreadable ciphertext even if removing it from storage fails.
export async function deleteDocument(id: string) {
  const existing = await prisma.document.findUnique({
    where: { id },
    select: { clientId: true, projectId: true, instance: true },
  });
  if (!existing) throw new Error("That file no longer exists.");
  const user = await requireEngagementAccess(existing.clientId, existing.projectId, existing.instance);
  const doc = await prisma.document.delete({ where: { id } });
  await objectStore.remove(doc.bucket, doc.storageKey).catch((err) => {
    console.error(`[documents] deleted row ${doc.id} but couldn't remove its object; its key is already destroyed`, err);
  });
  await recordAudit({
    entityType: "Document",
    entityId: doc.id,
    action: AUDIT.DOCUMENT_DELETED,
    summary: `Deleted "${doc.filename}"`,
    clientId: doc.clientId,
    projectId: doc.projectId,
    instance: doc.instance,
    periodName: doc.periodName,
    actor: actorFrom(user),
  });
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
  instance?: number;
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
      where: {
        projectId: scope.projectId,
        ...(scope.clientId ? { clientId: scope.clientId } : {}),
        ...(scope.instance ? { instance: scope.instance } : {}),
      },
      select: { clientId: true, instance: true, dueOffsetDays: true },
    }),
    prisma.clientActivity.findMany({
      where: {
        projectId: scope.projectId,
        ...(scope.clientId ? { clientId: scope.clientId } : {}),
        ...(scope.instance ? { instance: scope.instance } : {}),
        dueDateOverridden: false,
      },
      select: { id: true, clientId: true, instance: true, subTaskId: true, periodName: true, dueDate: true },
    }),
  ]);
  if (activities.length === 0) return 0;

  const periods = await prisma.accountingPeriod.findMany({
    where: { name: { in: [...new Set(activities.map((a) => a.periodName))] } },
    select: { name: true, endDate: true },
  });
  const periodEnd = new Map(periods.map((p) => [p.name, p.endDate]));
  // Each copy of the project has its own override, so key by engagement.
  const overrideByClient = new Map(assignments.map((a) => [`${a.clientId}:${a.instance}`, a.dueOffsetDays]));

  // One resolve per (client, period) pair rather than per row — a firm with
  // 400 engagements on a 12-step checklist is 4,800 rows but only 400 pairs.
  const resolved = new Map<string, Map<string, Date>>();
  function datesFor(clientId: string, instance: number, periodName: string): Map<string, Date> | null {
    const key = `${clientId}:${instance}:${periodName}`;
    const hit = resolved.get(key);
    if (hit) return hit;
    const end = periodEnd.get(periodName);
    if (!end) return null;
    const map = resolveStepDueDates({
      periodEnd: end,
      projectOffset: project!.dueOffsetDays,
      clientOverride: overrideByClient.get(`${clientId}:${instance}`) ?? null,
      steps: taskMaps.map((tm) => ({ subTaskId: tm.subTaskId, dueOffsetDays: tm.dueOffsetDays })),
    });
    resolved.set(key, map);
    return map;
  }

  // Batch rows that land on the same date into one updateMany instead of one
  // query per row.
  const byDate = new Map<number, string[]>();
  for (const a of activities) {
    const next = datesFor(a.clientId, a.instance, a.periodName)?.get(a.subTaskId);
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

// --- Recurrence start dates ---------------------------------------------------
//
// When a project's periods begin (src/lib/period-names.ts). Not retroactive:
// periods already open keep their dates, and the next one bridges onto the new
// schedule, so nothing is skipped or done twice. Independent of the due date.

function describeAnchorForAudit(anchor: Date | null): string {
  return anchor ? anchor.toISOString().slice(0, 10) : "calendar default";
}

export async function setProjectRecurrenceAnchor(projectId: string, value: string) {
  const user = await requireAdminAction();
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    include: { recurring: true },
  });
  const anchor = parseAnchorInput(value, project.recurring.type);
  await prisma.project.update({ where: { id: projectId }, data: { recurrenceAnchor: anchor } });
  await recordAudit({
    entityType: "Project",
    entityId: projectId,
    action: AUDIT.SCHEDULE_CHANGED,
    summary: `${project.name} now recurs from ${anchor ? isoDate(anchor) : "the calendar default"}`,
    fromValue: describeAnchorForAudit(project.recurrenceAnchor),
    toValue: describeAnchorForAudit(anchor),
    actor: actorFrom(user),
  });
  revalidatePath(`/projects/${projectId}`);
  revalidatePath("/admin/projects");
}

// One client's own start date. "" goes back to the project's.
export async function setAssignmentRecurrenceAnchor(
  clientId: string,
  projectId: string,
  value: string,
  instance: number = 1
) {
  const user = await requireEngagementAccess(clientId, projectId, instance);
  const key = { clientId, projectId, instance };
  const engagement = await prisma.projectClientMap.findUniqueOrThrow({
    where: engagementId(key),
    include: { project: { include: { recurring: true } }, client: { select: { companyName: true } } },
  });
  const type = engagement.project.recurring.type;
  const anchor = parseAnchorInput(value, type);
  await prisma.projectClientMap.update({
    where: engagementId(key),
    data: { recurrenceAnchor: anchor },
  });
  const next =
    engagement.currentPeriod && type !== "ONE_TIME"
      ? nextPeriodName(type, engagement.currentPeriod, effectiveAnchor(engagement.project.recurrenceAnchor, anchor))
      : null;
  await recordAudit({
    entityType: "ProjectClientMap",
    entityId: engagementKeyString(key),
    action: AUDIT.SCHEDULE_CHANGED,
    summary: anchor
      ? `${engagement.client.companyName}'s ${engagementLabel(engagement.project.name, engagement.name, instance)} now recurs from ${isoDate(anchor)}`
      : `${engagement.client.companyName}'s ${engagementLabel(engagement.project.name, engagement.name, instance)} follows the project's start date again`,
    fromValue: describeAnchorForAudit(engagement.recurrenceAnchor),
    toValue: describeAnchorForAudit(anchor),
    clientId,
    projectId,
    instance,
    contextLabel: `${engagement.client.companyName} · ${engagementLabel(engagement.project.name, engagement.name, instance)}`,
    actor: actorFrom(user),
  });
  revalidateAssignment(clientId, projectId);
  return { nextPeriod: next };
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
  offsetDays: number | null,
  instance: number = 1
) {
  await requireEngagementAccess(clientId, projectId, instance);
  if (offsetDays !== null) assertOffsetInRange(offsetDays);
  await prisma.projectClientMap.update({
    where: engagementId({ clientId, projectId, instance }),
    data: { dueOffsetDays: offsetDays === null ? null : clampOffset(offsetDays) },
  });
  const updated = await recomputeDueDates({ projectId, clientId, instance });
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
    await recomputeDueDates({
      clientId: activity.clientId,
      projectId: activity.projectId,
      instance: activity.instance,
    });
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

// The person responsible for this client's copy of the project. They (or,
// when it's cleared, the project's owner) can see the whole engagement, every
// period from here on is pre-assigned to them, and open tasks that nobody has
// yet are handed to them now. Tasks someone already has don't move.
export async function setEngagementDefaultAssignee(
  clientId: string,
  projectId: string,
  employeeId: string | null,
  instance: number = 1
) {
  const user = await requireEngagementAccess(clientId, projectId, instance);
  await assertEmployeeExists(employeeId || null);
  const key = { clientId, projectId, instance };
  const assignment = await prisma.projectClientMap.findUniqueOrThrow({
    where: engagementId(key),
    include: { defaultAssignee: true, client: true, project: true },
  });

  const nextId = employeeId || null;
  if (assignment.defaultAssigneeId === nextId) return { filled: 0 };

  const updated = await prisma.projectClientMap.update({
    where: engagementId(key),
    data: { defaultAssigneeId: nextId },
    include: { defaultAssignee: true },
  });

  // Fill the blanks with whoever is now responsible.
  const responsible = nextId ?? assignment.project.ownerId;
  let filled = 0;
  if (responsible) {
    const stepOwned = await prisma.projectTaskMap.findMany({
      where: { projectId, defaultAssigneeId: { not: null } },
      select: { subTaskId: true },
    });
    const res = await prisma.clientActivity.updateMany({
      where: {
        ...engagementWhere(key),
        assigneeId: null,
        status: { not: "DONE" },
        subTaskId: { notIn: stepOwned.map((s) => s.subTaskId) },
      },
      data: { assigneeId: responsible },
    });
    filled = res.count;
  }

  await recordAudit({
    entityType: "ProjectClientMap",
    entityId: engagementKeyString(key),
    action: AUDIT.DEFAULT_ASSIGNEE_CHANGED,
    summary: `Engagement owner: ${employeeName(assignment.defaultAssignee)} → ${employeeName(
      updated.defaultAssignee
    )}`,
    fromValue: assignment.defaultAssigneeId,
    toValue: nextId,
    clientId,
    projectId,
    instance,
    contextLabel: `${assignment.client.companyName} · ${engagementLabel(assignment.project.name, assignment.name, instance)}`,
    actor: actorFrom(user),
  });

  revalidateAssignment(clientId, projectId);
  revalidatePath("/activity");
  revalidatePath("/tasks");
  return { filled };
}

// Pushes the resolved defaults onto one period's rows. Only touches steps that
// are currently unassigned — silently reassigning work someone has already
// picked up would be a nasty surprise, and the bulk panel already exists for
// deliberate reassignment. Returns how many rows changed.
export async function applyDefaultAssignees(
  clientId: string,
  projectId: string,
  periodName: string,
  instance: number = 1
): Promise<number> {
  const user = await requireEngagementAccess(clientId, projectId, instance);

  const [assignment, taskMaps, unassigned] = await Promise.all([
    prisma.projectClientMap.findUniqueOrThrow({
      where: engagementId({ clientId, projectId, instance }),
      select: { defaultAssigneeId: true, project: { select: { ownerId: true } } },
    }),
    prisma.projectTaskMap.findMany({
      where: { projectId },
      select: { subTaskId: true, defaultAssigneeId: true },
    }),
    prisma.clientActivity.findMany({
      where: { clientId, projectId, instance, periodName, assigneeId: null },
      include: { subTask: { select: { name: true } } },
    }),
  ]);

  const defaults = resolveDefaultAssignees({
    steps: taskMaps,
    engagementDefaultId: assignment.defaultAssigneeId,
    projectOwnerId: assignment.project.ownerId,
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
      instance,
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
    instance: before.instance,
    periodName: before.periodName,
    contextLabel: `${before.client.companyName} · ${before.project.name}`,
    actor: actorFrom(user),
  });

  revalidateAssignment(before.clientId, before.projectId);
  revalidatePath("/workload");
  revalidatePath("/tasks");
}
