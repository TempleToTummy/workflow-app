import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { Role } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { newToken, SESSION_TTL_MS } from "@/lib/password";

// Session + role plumbing. Imports next/headers, so this module is server-only
// (importing it into a client component will error). The pure crypto lives in
// src/lib/password.ts.

export const SESSION_COOKIE = "wf_session";

export type CurrentUser = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  role: Role;
};

// Cookie writes are only allowed in Server Actions and Route Handlers — call
// this from login / acceptInvite, not from a page render.
export async function createSession(employeeId: string): Promise<void> {
  const id = newToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await prisma.session.create({ data: { id, employeeId, expiresAt } });
  const jar = await cookies();
  jar.set(SESSION_COOKIE, id, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.NODE_ENV === "production",
    expires: expiresAt,
  });
}

export async function destroySession(): Promise<void> {
  const jar = await cookies();
  const id = jar.get(SESSION_COOKIE)?.value;
  if (id) await prisma.session.deleteMany({ where: { id } });
  jar.delete(SESSION_COOKIE);
}

// Read-only — safe to call from any server component, layout, or action.
export async function getCurrentUser(): Promise<CurrentUser | null> {
  const jar = await cookies();
  const id = jar.get(SESSION_COOKIE)?.value;
  if (!id) return null;

  const session = await prisma.session.findUnique({
    where: { id },
    include: { employee: true },
  });
  if (!session || session.expiresAt < new Date()) return null;

  const e = session.employee;
  return {
    id: e.id,
    firstName: e.firstName,
    lastName: e.lastName,
    email: e.email,
    role: e.role,
  };
}

export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

// Visibility scope for the operational pages. Admins see the whole firm;
// employees see only engagements that have at least one task assigned to
// them. Returns the employee id to scope by, or null for "no scope".
export function assigneeScope(user: CurrentUser): string | null {
  return user.role === "ADMIN" ? null : user.id;
}

export async function requireAdmin(): Promise<CurrentUser> {
  const user = await requireUser();
  if (user.role !== "ADMIN") redirect("/");
  return user;
}
