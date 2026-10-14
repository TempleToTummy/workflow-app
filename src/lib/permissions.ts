import type { Role } from "@prisma/client";

// Who may change what. Pure — no next/*, no Prisma client — so the whole
// policy is covered by scripts/test-permissions.ts.
//
// Writing needs the same access that reading does (src/lib/access.ts), plus a
// few things only an admin does:
//
//   engagement  Working an engagement: step status, assignees, subtasks,
//               notes, files, comments, timers, client requests, the
//               engagement's own deadline override and default owner. Needs
//               being ON the engagement: its responsible person (the
//               engagement's owner, else the project's owner) or anyone with
//               a task in it.
//   client      Editing a client's details and contacts. Needs being on any
//               of that client's engagements.
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
  // Is the user on this engagement (responsible for it, or has a task in it)?
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
