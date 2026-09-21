import { prisma } from "@/lib/prisma";
import { getCurrentUser, type CurrentUser } from "@/lib/auth";

// The audit trail.
//
// Every meaningful change records one AuditEvent. The rules that make this
// worth having, rather than a second set of timestamps:
//
//   1. Append-only. Nothing in the app updates or deletes an AuditEvent.
//   2. No foreign keys. A history row has to outlive the thing it describes —
//      deleting a client must not erase the record of what was done to it — so
//      ids are plain strings and every row carries a denormalized label.
//   3. Written with the actor resolved at the time, never inferred later.
//   4. Recording must never break the operation being recorded. A failure to
//      write history is logged and swallowed; refusing to mark a task done
//      because the audit insert failed would be the worse outcome.

export const AUDIT = {
  // Work
  STATUS_CHANGED: "status.changed",
  ASSIGNEE_CHANGED: "assignee.changed",
  DUE_DATE_CHANGED: "due.changed",
  NOTES_CHANGED: "notes.changed",
  ENGAGEMENT_CREATED: "engagement.created",
  PERIOD_OPENED: "period.opened",
  // Configuration
  DUE_RULE_CHANGED: "due_rule.changed",
  DEFAULT_ASSIGNEE_CHANGED: "default_assignee.changed",
  // People and access
  LOGIN_SUCCEEDED: "login.succeeded",
  LOGIN_FAILED: "login.failed",
  PASSWORD_RESET_REQUESTED: "password.reset_requested",
  PASSWORD_RESET_COMPLETED: "password.reset_completed",
  INVITE_ACCEPTED: "invite.accepted",
  INVITE_ISSUED: "invite.issued",
  ROLE_CHANGED: "role.changed",
  ACCESS_REVOKED: "access.revoked",
  EMPLOYEE_CREATED: "employee.created",
  EMPLOYEE_DELETED: "employee.deleted",
  // Clients
  CLIENT_CREATED: "client.created",
  CLIENT_UPDATED: "client.updated",
  CLIENT_DELETED: "client.deleted",
} as const;

export type AuditAction = (typeof AUDIT)[keyof typeof AUDIT];

// Labels used when there is no signed-in actor.
export const SYSTEM_ACTOR = "System";
export const ANONYMOUS_ACTOR = "Signed-out visitor";

export type AuditInput = {
  entityType: string;
  entityId: string;
  action: AuditAction;
  summary: string;
  fromValue?: string | null;
  toValue?: string | null;
  clientId?: string | null;
  projectId?: string | null;
  periodName?: string | null;
  contextLabel?: string | null;
  // Pass explicitly for events with no session (a password reset request, the
  // scheduler) or to avoid re-reading the session the caller already has.
  actor?: { id: string | null; label: string } | null;
};

export function actorFrom(user: CurrentUser): { id: string; label: string } {
  return { id: user.id, label: `${user.firstName} ${user.lastName}` };
}

// Records one event. Never throws — see rule 4 above.
export async function recordAudit(input: AuditInput): Promise<void> {
  try {
    let actor = input.actor;
    if (actor === undefined) {
      const user = await getCurrentUser();
      actor = user ? actorFrom(user) : { id: null, label: ANONYMOUS_ACTOR };
    }

    await prisma.auditEvent.create({
      data: {
        entityType: input.entityType,
        entityId: input.entityId,
        action: input.action,
        actorId: actor?.id ?? null,
        actorLabel: actor?.label ?? SYSTEM_ACTOR,
        summary: input.summary,
        fromValue: input.fromValue ?? null,
        toValue: input.toValue ?? null,
        clientId: input.clientId ?? null,
        projectId: input.projectId ?? null,
        periodName: input.periodName ?? null,
        contextLabel: input.contextLabel ?? null,
      },
    });
  } catch (err) {
    console.error("[audit] failed to record event", input.action, err);
  }
}

// Records several events in one insert. Used by bulk operations — assigning
// twelve steps at once should leave twelve rows, not one vague summary, but it
// shouldn't be twelve round trips either.
export async function recordAuditMany(inputs: AuditInput[]): Promise<void> {
  if (inputs.length === 0) return;
  try {
    const user = await getCurrentUser();
    const fallback = user ? actorFrom(user) : { id: null, label: ANONYMOUS_ACTOR };
    await prisma.auditEvent.createMany({
      data: inputs.map((input) => {
        const actor = input.actor === undefined ? fallback : input.actor;
        return {
          entityType: input.entityType,
          entityId: input.entityId,
          action: input.action,
          actorId: actor?.id ?? null,
          actorLabel: actor?.label ?? SYSTEM_ACTOR,
          summary: input.summary,
          fromValue: input.fromValue ?? null,
          toValue: input.toValue ?? null,
          clientId: input.clientId ?? null,
          projectId: input.projectId ?? null,
          periodName: input.periodName ?? null,
          contextLabel: input.contextLabel ?? null,
        };
      }),
    });
  } catch (err) {
    console.error("[audit] failed to record batch", err);
  }
}

// --- Presentation -------------------------------------------------------------

// How each action reads in a feed, and which tone to render it in. Unknown
// actions fall back to the raw verb rather than being hidden, so an event type
// added later still shows up.
const ACTION_META: Record<string, { label: string; tone: "neutral" | "good" | "warn" | "bad" }> = {
  [AUDIT.STATUS_CHANGED]: { label: "Status", tone: "neutral" },
  [AUDIT.ASSIGNEE_CHANGED]: { label: "Assignee", tone: "neutral" },
  [AUDIT.DUE_DATE_CHANGED]: { label: "Due date", tone: "neutral" },
  [AUDIT.NOTES_CHANGED]: { label: "Notes", tone: "neutral" },
  [AUDIT.ENGAGEMENT_CREATED]: { label: "Engagement", tone: "good" },
  [AUDIT.PERIOD_OPENED]: { label: "Period", tone: "good" },
  [AUDIT.DUE_RULE_CHANGED]: { label: "Due rule", tone: "neutral" },
  [AUDIT.DEFAULT_ASSIGNEE_CHANGED]: { label: "Default assignee", tone: "neutral" },
  [AUDIT.LOGIN_SUCCEEDED]: { label: "Sign in", tone: "neutral" },
  [AUDIT.LOGIN_FAILED]: { label: "Failed sign in", tone: "warn" },
  [AUDIT.PASSWORD_RESET_REQUESTED]: { label: "Reset requested", tone: "warn" },
  [AUDIT.PASSWORD_RESET_COMPLETED]: { label: "Password reset", tone: "warn" },
  [AUDIT.INVITE_ACCEPTED]: { label: "Invite accepted", tone: "good" },
  [AUDIT.INVITE_ISSUED]: { label: "Invite issued", tone: "neutral" },
  [AUDIT.ROLE_CHANGED]: { label: "Role", tone: "warn" },
  [AUDIT.ACCESS_REVOKED]: { label: "Access revoked", tone: "bad" },
  [AUDIT.EMPLOYEE_CREATED]: { label: "Employee added", tone: "good" },
  [AUDIT.EMPLOYEE_DELETED]: { label: "Employee removed", tone: "bad" },
  [AUDIT.CLIENT_CREATED]: { label: "Client added", tone: "good" },
  [AUDIT.CLIENT_UPDATED]: { label: "Client", tone: "neutral" },
  [AUDIT.CLIENT_DELETED]: { label: "Client removed", tone: "bad" },
};

export function actionMeta(action: string) {
  return ACTION_META[action] ?? { label: action, tone: "neutral" as const };
}

// The actions offered in the log's filter, grouped so the menu is readable.
export const AUDIT_FILTER_GROUPS: { heading: string; actions: string[] }[] = [
  {
    heading: "Work",
    actions: [
      AUDIT.STATUS_CHANGED,
      AUDIT.ASSIGNEE_CHANGED,
      AUDIT.DUE_DATE_CHANGED,
      AUDIT.NOTES_CHANGED,
      AUDIT.ENGAGEMENT_CREATED,
      AUDIT.PERIOD_OPENED,
    ],
  },
  {
    heading: "Configuration",
    actions: [AUDIT.DUE_RULE_CHANGED, AUDIT.DEFAULT_ASSIGNEE_CHANGED],
  },
  {
    heading: "Access",
    actions: [
      AUDIT.LOGIN_SUCCEEDED,
      AUDIT.LOGIN_FAILED,
      AUDIT.PASSWORD_RESET_REQUESTED,
      AUDIT.PASSWORD_RESET_COMPLETED,
      AUDIT.INVITE_ISSUED,
      AUDIT.INVITE_ACCEPTED,
      AUDIT.ROLE_CHANGED,
      AUDIT.ACCESS_REVOKED,
      AUDIT.EMPLOYEE_CREATED,
      AUDIT.EMPLOYEE_DELETED,
    ],
  },
  {
    heading: "Clients",
    actions: [AUDIT.CLIENT_CREATED, AUDIT.CLIENT_UPDATED, AUDIT.CLIENT_DELETED],
  },
];

// Status enum → the words people use for it, for readable summaries.
export const STATUS_WORDS: Record<string, string> = {
  NOT_STARTED: "Not started",
  IN_PROGRESS: "In progress",
  AWAITING_REVIEW: "Awaiting review",
  DONE: "Done",
};
