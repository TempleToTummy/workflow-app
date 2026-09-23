import { prisma } from "@/lib/prisma";
import { requireUser, type CurrentUser } from "@/lib/auth";
import { isAllowed, DENIED } from "@/lib/permissions";

// Server-side enforcement of src/lib/permissions.ts. Deliberately NOT a
// "use server" module: these are helpers for actions and route handlers, and
// exporting them from a server-action file would publish them as endpoints.
//
// Each require* reads the session itself, so an action's first line can be the
// access check and nothing runs before it. They THROW rather than redirect: a
// redirect from inside a server action navigates the user somewhere unrelated
// with no explanation, while a thrown message lands in the component's error
// state next to the control that was used.

export async function isOnEngagement(userId: string, clientId: string, projectId: string) {
  const n = await prisma.clientActivity.count({
    where: { clientId, projectId, assigneeId: userId },
  });
  return n > 0;
}

export async function isOnClient(userId: string, clientId: string) {
  const n = await prisma.clientActivity.count({ where: { clientId, assigneeId: userId } });
  return n > 0;
}

export async function canAccessEngagement(
  user: CurrentUser,
  clientId: string,
  projectId: string
): Promise<boolean> {
  if (user.role === "ADMIN") return true;
  return isAllowed("engagement", {
    role: user.role,
    onEngagement: await isOnEngagement(user.id, clientId, projectId),
  });
}

export async function canAccessClient(user: CurrentUser, clientId: string): Promise<boolean> {
  if (user.role === "ADMIN") return true;
  return isAllowed("client", { role: user.role, onClient: await isOnClient(user.id, clientId) });
}

export async function requireEngagementAccess(
  clientId: string,
  projectId: string
): Promise<CurrentUser> {
  const user = await requireUser();
  if (!clientId || !projectId || !(await canAccessEngagement(user, clientId, projectId))) {
    throw new Error(DENIED.engagement);
  }
  return user;
}

export async function requireClientAccess(clientId: string): Promise<CurrentUser> {
  const user = await requireUser();
  if (!clientId || !(await canAccessClient(user, clientId))) {
    throw new Error(DENIED.client);
  }
  return user;
}

// For actions that take a task id. Returns the engagement the task belongs to,
// read from the row — never from the caller — so the rest of the action can
// use it without trusting anything in the request.
export async function requireActivityAccess(activityId: string) {
  const user = await requireUser();
  const activity = activityId
    ? await prisma.clientActivity.findUnique({
        where: { id: activityId },
        select: { id: true, clientId: true, projectId: true, periodName: true },
      })
    : null;
  if (!activity || !(await canAccessEngagement(user, activity.clientId, activity.projectId))) {
    throw new Error(DENIED.engagement);
  }
  return { user, activity };
}

// The action-layer admin gate. requireAdmin() in auth.ts redirects, which is
// right for a page and wrong for a button.
export async function requireAdminAction(): Promise<CurrentUser> {
  const user = await requireUser();
  if (!isAllowed("admin", { role: user.role })) throw new Error(DENIED.admin);
  return user;
}

// An assignee has to be a real employee. The foreign key would reject a bogus
// id anyway, but as an unreadable Prisma error.
export async function assertEmployeeExists(employeeId: string | null): Promise<void> {
  if (!employeeId) return;
  const found = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: { id: true },
  });
  if (!found) throw new Error("That person is no longer on the staff list. Refresh and try again.");
}
