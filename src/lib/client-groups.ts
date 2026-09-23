import { prisma } from "@/lib/prisma";
import { assigneeScope, type CurrentUser } from "@/lib/auth";

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
