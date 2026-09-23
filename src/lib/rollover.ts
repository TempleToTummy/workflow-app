import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { nextPeriodName } from "@/lib/periods";
import { openPeriodForAssignment } from "@/lib/scheduler";

// Lives outside src/lib/actions.ts so both the single-step and the bulk status
// actions can call it without it becoming a server action of its own (every
// export of a "use server" module is a public endpoint, and this one does no
// access checking).

// Mirrors the source app's period-rollover trigger: once every task in the
// assignment's current period is Done, advance the client's project to the
// next accounting period and generate that period's (Not Started) task rows.
// One-time projects (no next period) are marked complete and inactive
// instead of rolling forward. The caller is responsible for access checks.
export async function maybeRollPeriodForward(clientId: string, projectId: string, periodName: string) {
  const assignment = await prisma.projectClientMap.findUnique({
    where: { clientId_projectId: { clientId, projectId } },
    include: { client: { select: { archivedAt: true } } },
  });
  // Already rolled past this period (or the assignment is gone) — nothing to do.
  if (!assignment || assignment.currentPeriod !== periodName) return;
  // An archived client gets no new work, however its last period was closed;
  // restoring it resumes from the current period (restoreClient in actions.ts).
  if (assignment.client.archivedAt) return;

  const siblings = await prisma.clientActivity.findMany({
    where: { clientId, projectId, periodName },
  });
  if (siblings.length === 0 || !siblings.every((a) => a.status === "DONE")) return;

  const project = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    include: { recurring: true },
  });
  const nextName = nextPeriodName(project.recurring.type, periodName);

  if (!nextName) {
    await prisma.projectClientMap.update({
      where: { clientId_projectId: { clientId, projectId } },
      data: { completedDate: new Date(), active: false },
    });
    return;
  }

  // Finishing early opens the next period early. Row generation goes through
  // the same helper the scheduler uses, so rows created this way carry the
  // same resolved due dates as rows the nightly job would have created.
  await openPeriodForAssignment({
    clientId,
    projectId,
    periodName: nextName,
    project: {
      recurringId: project.recurringId,
      recurring: { type: project.recurring.type },
      dueOffsetDays: project.dueOffsetDays,
    },
    clientOverride: assignment.dueOffsetDays,
    engagementDefaultAssigneeId: assignment.defaultAssigneeId,
  });

  await prisma.projectClientMap.update({
    where: { clientId_projectId: { clientId, projectId } },
    data: { currentPeriod: nextName, completedDate: new Date() },
  });

  revalidatePath("/");
  revalidatePath("/tasks");
  revalidatePath(`/assignments/${clientId}/${projectId}`);
  revalidatePath(`/clients/${clientId}`);
}
