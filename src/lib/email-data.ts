import { prisma } from "@/lib/prisma";
import { assigneeScope, type CurrentUser } from "@/lib/auth";
import type { ComposerClient, ComposerTemplate } from "@/components/email-composer";

// Read helpers shared by the Email pages. Kept out of email-actions.ts because
// that file is "use server" — everything exported from it becomes a callable
// server action, and these are plain server-side reads.

// Which clients a user may correspond with. Employees are limited to clients
// they have a task on, matching assigneeScope() everywhere else in the app —
// otherwise the compose screen's client list would leak the whole book of
// business through a dropdown.
export async function composerClients(user: CurrentUser): Promise<ComposerClient[]> {
  const mine = assigneeScope(user);

  const clients = await prisma.client.findMany({
    where: mine ? { activities: { some: { assigneeId: mine } } } : undefined,
    include: {
      contacts: true,
      projectAssignments: {
        where: { active: true },
        include: { project: { select: { id: true, name: true } } },
      },
    },
    orderBy: { companyName: "asc" },
  });

  return clients.map((client) => ({
    id: client.id,
    name: client.companyName,
    email: client.email,
    contacts: client.contacts
      // A contact with no address can't be written to, so it isn't offered.
      .filter((c) => c.email && c.email.includes("@"))
      .map((c) => ({
        id: c.id,
        name: [c.firstName, c.lastName].filter(Boolean).join(" ") || c.email!,
        email: c.email!,
        firstName: c.firstName,
      })),
    projects: client.projectAssignments.map((a) => ({
      id: a.projectId,
      name: a.project.name,
      currentPeriod: a.currentPeriod,
    })),
  }));
}

export async function composerTemplates(): Promise<ComposerTemplate[]> {
  const templates = await prisma.emailTemplate.findMany({
    orderBy: [{ builtIn: "desc" }, { name: "asc" }],
    select: { key: true, name: true, description: true },
  });
  return templates;
}

// The Prisma `where` restricting an employee to messages about engagements
// they work on. Admins get no restriction.
export function messageScope(user: CurrentUser) {
  const mine = assigneeScope(user);
  if (!mine) return {};
  return {
    OR: [
      { sentById: mine },
      { client: { activities: { some: { assigneeId: mine } } } },
    ],
  };
}
