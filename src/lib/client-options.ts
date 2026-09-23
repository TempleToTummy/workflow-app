import { prisma } from "@/lib/prisma";
import { assigneeScope, type CurrentUser } from "@/lib/auth";

// Filter options for client groups and tags.
//
// Client.groupName came over from the source schema and nothing ever used it.
// It is now a real grouping: a filter on the dashboard, tasks and clients
// pages, and a grouped view of the client list. These are the reads; the
// group is still edited on the client form.

// Distinct group names the user can see, for filter chips and the form's
// suggestions. Scoped like everything else, so an employee's dropdown can't
// leak the names of groups made up of clients they don't work with.
export async function clientGroupNames(user: CurrentUser): Promise<string[]> {
  const mine = assigneeScope(user);
  const rows = await prisma.client.findMany({
    where: {
      groupName: { not: null },
      archivedAt: null,
      ...(mine ? { activities: { some: { assigneeId: mine } } } : {}),
    },
    select: { groupName: true },
    distinct: ["groupName"],
    orderBy: { groupName: "asc" },
  });
  return rows.map((r) => r.groupName!).filter((g) => g.trim() !== "");
}

// Tags attached to at least one client the user can see, for the Tag chip.
// Scoped for the same reason as the groups: a tag name can itself say
// something about a client ("Audit in progress").
export async function visibleTags(user: CurrentUser) {
  const mine = assigneeScope(user);
  return prisma.tag.findMany({
    where: mine
      ? { clients: { some: { client: { archivedAt: null, activities: { some: { assigneeId: mine } } } } } }
      : undefined,
    orderBy: { name: "asc" },
    select: { id: true, name: true, color: true },
  });
}

// Saved views for a page: the user's own plus every shared one.
export async function savedViewsFor(user: CurrentUser, path: string) {
  const views = await prisma.savedView.findMany({
    where: { path, OR: [{ ownerId: user.id }, { shared: true }] },
    orderBy: { name: "asc" },
  });
  return views.map((v) => ({
    id: v.id,
    name: v.name,
    query: v.query,
    shared: v.shared,
    mine: v.ownerId === user.id,
  }));
}
