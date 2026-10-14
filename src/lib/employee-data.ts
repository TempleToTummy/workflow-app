import { prisma } from "@/lib/prisma";
import { RECURRING_SHORT_LABELS } from "@/lib/period-names";
import type { EmployeeProjectOption } from "@/components/employee-projects";

// The "Projects they handle" choices for the employee form (New and Edit).
// `employeeId` is the person being edited, so their own projects aren't shown
// as "handled by" somebody else. Omit it when creating.
export async function employeeProjectOptions(
  employeeId?: string
): Promise<{ projects: EmployeeProjectOption[]; owned: string[] }> {
  const projects = await prisma.project.findMany({
    orderBy: { name: "asc" },
    include: {
      recurring: true,
      owner: { select: { firstName: true, lastName: true } },
      _count: { select: { clientAssignments: { where: { active: true, client: { archivedAt: null } } } } },
    },
  });
  return {
    owned: employeeId ? projects.filter((p) => p.ownerId === employeeId).map((p) => p.id) : [],
    projects: projects.map((p) => ({
      id: p.id,
      name: p.name,
      recurringLabel: RECURRING_SHORT_LABELS[p.recurring.type],
      otherOwner: p.owner && p.ownerId !== employeeId ? `${p.owner.firstName} ${p.owner.lastName}` : null,
      activeClients: p._count.clientAssignments,
    })),
  };
}
