import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/auth";
import { canSee, visibleScope } from "@/lib/access";
import { engagementLabel, projectRef } from "@/lib/engagements";
import type { ComposerClient, ComposerTemplate } from "@/components/email-composer";

// Read helpers shared by the Email pages. Kept out of email-actions.ts because
// that file is "use server" — everything exported from it becomes a callable
// server action, and these are plain server-side reads.

// Which clients a user may correspond with. Employees are limited to clients
// they're on (src/lib/access.ts) — otherwise the compose screen's client list
// would leak the whole book of business through a dropdown.
export async function composerClients(user: CurrentUser): Promise<ComposerClient[]> {
  const scope = await visibleScope(user);

  const clients = await prisma.client.findMany({
    where: { archivedAt: null, ...(scope ? { id: { in: [...scope.clientIds] } } : {}) },
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
    // One option per engagement: a client running a project twice gets both.
    projects: client.projectAssignments
      .filter((a) => canSee(scope, a))
      .map((a) => ({
        id: projectRef(a.projectId, a.instance),
        name: engagementLabel(a.project.name, a.name, a.instance),
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

// The Prisma `where` restricting an employee to messages they sent or about
// clients they're on. Admins get no restriction.
export async function messageScope(user: CurrentUser) {
  const scope = await visibleScope(user);
  if (!scope) return {};
  return {
    OR: [{ sentById: user.id }, { clientId: { in: [...scope.clientIds] } }],
  };
}
