import type { Role } from "@prisma/client";

// Who may change what. Pure — no next/*, no Prisma client — so the whole
// policy is covered by scripts/test-permissions.ts.
//
// The app already decided who may SEE what (assigneeScope in auth.ts: admins
// see the firm, an employee sees engagements with at least one step assigned
// to them). Before this module, writes only checked "is somebody signed in",
// so an employee could change any record whose id they could guess or had
// kept from an earlier assignment. The rule now is that writing needs the
// same access that reading does, plus a few things only an admin does:
//
//   engagement  Working an engagement: step status, assignees, subtasks,
//               notes, files, comments, timers, client requests, the
//               engagement's own deadline override and default owner. Needs a
//               task on that client + project (any period — the same gate the
//               assignment page applies, so past periods stay workable).
//   client      Editing a client's details and contacts. Needs a task
//               anywhere for that client.
//   admin       Firm structure: adding, archiving or deleting a client,
//               turning a service on for a client, and editing a service
//               template (checklist steps, the service's due rule, step
//               owners, estimates). A template edit changes the work of every
//               client on that service, including ones the editor can't see,
//               so "can see one engagement" is not enough for it.
//
// ADMIN passes every check.

export type Capability = "engagement" | "client" | "admin";

export type AccessFacts = {
  role: Role;
  // Does the user have at least one step assigned on this client + project?
  onEngagement?: boolean;
  // ...on any of this client's engagements?
  onClient?: boolean;
};

export function isAllowed(capability: Capability, facts: AccessFacts): boolean {
  if (facts.role === "ADMIN") return true;
  switch (capability) {
    case "engagement":
      return facts.onEngagement === true;
    case "client":
      // Being on one of the client's engagements is being on the client.
      return facts.onClient === true || facts.onEngagement === true;
    case "admin":
      return false;
  }
}

// One message per capability, and deliberately the same whether the record
// doesn't exist or exists but isn't yours — otherwise the error itself would
// confirm which ids are real.
export const DENIED: Record<Capability, string> = {
  engagement: "That engagement doesn't exist or isn't one you're assigned to.",
  client: "That client doesn't exist or isn't one you work with.",
  admin: "Only an admin can do that.",
};
