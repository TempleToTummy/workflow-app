import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import type { Role } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { newToken, hashToken, SESSION_TTL_MS } from "@/lib/password";

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
  // The session this request is using, so the Account page can mark "this
  // device" and never offer to sign it out from under itself.
  sessionId: string;
};

// How often lastSeenAt is refreshed. Every request would be a write per page
// load; a few minutes is precise enough for "last active".
const TOUCH_INTERVAL_MS = 5 * 60_000;

// Device details for the sessions list. Best effort — a missing header just
// shows as "Unknown device".
async function requestMetadata(): Promise<{ userAgent: string | null; ipAddress: string | null }> {
  try {
    const h = await headers();
    const forwarded = h.get("x-forwarded-for")?.split(",")[0]?.trim();
    return {
      userAgent: h.get("user-agent")?.slice(0, 400) ?? null,
      ipAddress: (forwarded || h.get("x-real-ip") || null)?.slice(0, 64) ?? null,
    };
  } catch {
    return { userAgent: null, ipAddress: null };
  }
}

// Cookie writes are only allowed in Server Actions and Route Handlers — call
// this from login / acceptInvite, not from a page render.
export async function createSession(employeeId: string): Promise<void> {
  const id = newToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const meta = await requestMetadata();
  await prisma.session.create({ data: { id, employeeId, expiresAt, ...meta } });
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

  if (Date.now() - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
    // Fire and forget: a failed touch must never fail the page.
    prisma.session
      .update({ where: { id }, data: { lastSeenAt: new Date() } })
      .catch(() => {});
  }

  const e = session.employee;
  return {
    id: e.id,
    firstName: e.firstName,
    lastName: e.lastName,
    email: e.email,
    role: e.role,
    sessionId: session.id,
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

// --- Two-factor sign-in challenge ----------------------------------------------
//
// Between "password correct" and "code correct" the browser holds a short-lived
// challenge cookie, NOT a session: nothing that checks for a session will ever
// accept it. Only the SHA-256 of the token is stored (LoginChallenge.id).

export const MFA_COOKIE = "wf_mfa";
const CHALLENGE_TTL_MS = 10 * 60_000;
export const MAX_CHALLENGE_ATTEMPTS = 5;

export async function createLoginChallenge(employeeId: string): Promise<void> {
  const token = newToken();
  // One pending challenge per person: starting a new sign-in replaces any
  // earlier half-finished one.
  await prisma.loginChallenge.deleteMany({ where: { employeeId } });
  await prisma.loginChallenge.create({
    data: {
      id: hashToken(token),
      employeeId,
      expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
    },
  });
  const jar = await cookies();
  jar.set(MFA_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.NODE_ENV === "production",
    maxAge: CHALLENGE_TTL_MS / 1000,
  });
}

export async function readLoginChallenge() {
  const jar = await cookies();
  const token = jar.get(MFA_COOKIE)?.value;
  if (!token) return null;
  const challenge = await prisma.loginChallenge.findUnique({
    where: { id: hashToken(token) },
    include: { employee: true },
  });
  if (!challenge || challenge.expiresAt < new Date()) return null;
  return challenge;
}

export async function clearLoginChallenge(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(MFA_COOKIE)?.value;
  if (token) await prisma.loginChallenge.deleteMany({ where: { id: hashToken(token) } });
  jar.delete(MFA_COOKIE);
}
