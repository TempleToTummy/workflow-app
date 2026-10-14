import { prisma } from "@/lib/prisma";
import { requireUser, type CurrentUser } from "@/lib/auth";
import { isAllowed, DENIED } from "@/lib/permissions";
import {
  engagementId,
  responsibleId,
  engagementKeyString,
  engagementWhere,
  type EngagementKey,
} from "@/lib/engagements";

// Server-side enforcement of src/lib/permissions.ts. Deliberately NOT a
// "use server" module: these are helpers for actions and route handlers, and
// exporting them from a server-action file would publish them as endpoints.
//
// Each require* reads the session itself, so an action's first line can be the
// access check and nothing runs before it. They THROW rather than redirect: a
// redirect from inside a server action navigates the user somewhere unrelated
// with no explanation, while a thrown message lands in the component's error
// state next to the control that was used.

// --- Who is on an engagement --------------------------------------------------
//
// Visibility is decided at the PROJECT level, not task by task. A person is
// on a client's engagement (and sees every task in it, whoever those tasks
// are assigned to) when:
//
//   * they are its responsible person — the engagement's own owner
//     (ProjectClientMap.defaultAssigneeId), or, when it has none, the
//     project's owner (Project.ownerId, "Projects they handle"); or
//   * any task in it is assigned to them. Per-task assignment still exists
//     and still lets someone in, but it's no longer the only way.
//
// Admins see everything.


export async function isOnEngagement(userId: string, key: EngagementKey): Promise<boolean> {
  const engagement = await prisma.projectClientMap.findUnique({
    where: engagementId(key),
    select: { defaultAssigneeId: true, project: { select: { ownerId: true } } },
  });
  if (!engagement) return false;
  if (responsibleId(engagement) === userId) return true;
  const n = await prisma.clientActivity.count({ where: { ...engagementWhere(key), assigneeId: userId } });
  return n > 0;
}

export async function isOnClient(userId: string, clientId: string): Promise<boolean> {
  const scope = await engagementsFor(userId);
  return scope.clientIds.has(clientId);
}

export type EngagementScope = {
  keys: Set<string>; // engagementKeyString(...)
  list: EngagementKey[];
  clientIds: Set<string>;
  projectIds: Set<string>;
};

// Every engagement one person is on, by the rule above.
export async function engagementsFor(userId: string): Promise<EngagementScope> {
  const [owned, tasked] = await Promise.all([
    prisma.projectClientMap.findMany({
      where: {
        OR: [{ defaultAssigneeId: userId }, { defaultAssigneeId: null, project: { ownerId: userId } }],
      },
      select: { clientId: true, projectId: true, instance: true },
    }),
    prisma.clientActivity.findMany({
      where: { assigneeId: userId },
      distinct: ["clientId", "projectId", "instance"],
      select: { clientId: true, projectId: true, instance: true },
    }),
  ]);
  const scope: EngagementScope = { keys: new Set(), list: [], clientIds: new Set(), projectIds: new Set() };
  for (const k of [...owned, ...tasked]) {
    const ks = engagementKeyString(k);
    if (scope.keys.has(ks)) continue;
    scope.keys.add(ks);
    scope.list.push(k);
    scope.clientIds.add(k.clientId);
    scope.projectIds.add(k.projectId);
  }
  return scope;
}

// What a signed-in user can see: null = everything (admin).
export async function visibleScope(user: CurrentUser): Promise<EngagementScope | null> {
  return user.role === "ADMIN" ? null : engagementsFor(user.id);
}

// A Prisma `where` fragment limiting any engagement-scoped table (tasks, notes,
// files, time, requests) to what the scope can see.
export function engagementFilter(scope: EngagementScope | null) {
  if (!scope) return {};
  if (scope.list.length === 0) return { id: "__none__" };
  return { OR: scope.list.map(engagementWhere) };
}

export function canSee(scope: EngagementScope | null, key: { clientId: string; projectId: string; instance?: number | null }): boolean {
  return !scope || scope.keys.has(engagementKeyString(key));
}

export async function canAccessEngagement(
  user: CurrentUser,
  clientId: string,
  projectId: string,
  instance: number = 1
): Promise<boolean> {
  if (user.role === "ADMIN") return true;
  return isAllowed("engagement", {
    role: user.role,
    onEngagement: await isOnEngagement(user.id, { clientId, projectId, instance }),
  });
}

export async function canAccessClient(user: CurrentUser, clientId: string): Promise<boolean> {
  if (user.role === "ADMIN") return true;
  return isAllowed("client", { role: user.role, onClient: await isOnClient(user.id, clientId) });
}

export async function requireEngagementAccess(
  clientId: string,
  projectId: string,
  instance: number = 1
): Promise<CurrentUser> {
  const user = await requireUser();
  if (!clientId || !projectId || !(await canAccessEngagement(user, clientId, projectId, instance))) {
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
        select: { id: true, clientId: true, projectId: true, instance: true, periodName: true },
      })
    : null;
  if (!activity || !(await canAccessEngagement(user, activity.clientId, activity.projectId, activity.instance))) {
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
