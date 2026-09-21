"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { createSession, destroySession, getCurrentUser } from "@/lib/auth";
import {
  hashPassword,
  verifyPassword,
  newToken,
  hashToken,
  resetExpiry,
  RESET_TTL_LABEL,
  MIN_PASSWORD_LENGTH,
} from "@/lib/password";
import { rateLimit, clearRateLimit, LIMITS } from "@/lib/rate-limit";
import { sendSystemEmail, renderResetEmail } from "@/lib/system-email";
import { firmName } from "@/lib/email";
import { recordAudit, AUDIT, ANONYMOUS_ACTOR } from "@/lib/audit";

const BAD_LOGIN = "Incorrect email or password.";

// The reset flow answers identically whether or not an account exists, so the
// form can't be used to discover who works here.
const RESET_ACKNOWLEDGEMENT =
  "If that email belongs to an account, a reset link is on its way. Check your inbox.";

export async function login(data: { email: string; password: string }) {
  const email = data.email.trim().toLowerCase();
  const password = data.password;
  if (!email || !password) throw new Error(BAD_LOGIN);

  // Throttled per address. Without this the form is a free brute-force target.
  const limit = rateLimit(`login:${email}`, LIMITS.LOGIN);
  if (!limit.ok) {
    throw new Error(
      `Too many sign-in attempts. Try again in ${Math.ceil(limit.retryAfterSeconds / 60)} minute(s).`
    );
  }

  const employee = await prisma.employee.findUnique({ where: { email } });
  // Same message whether the account is missing, invite-pending, or the
  // password is wrong — no account enumeration.
  const ok =
    employee?.passwordHash != null &&
    (await verifyPassword(password, employee.passwordHash));

  if (!ok) {
    await recordAudit({
      entityType: "Employee",
      entityId: employee?.id ?? email,
      action: AUDIT.LOGIN_FAILED,
      summary: `Failed sign-in attempt for ${email}`,
      toValue: email,
      contextLabel: employee ? `${employee.firstName} ${employee.lastName}` : email,
      actor: { id: null, label: ANONYMOUS_ACTOR },
    });
    throw new Error(BAD_LOGIN);
  }

  clearRateLimit(`login:${email}`);
  await createSession(employee!.id);
  await recordAudit({
    entityType: "Employee",
    entityId: employee!.id,
    action: AUDIT.LOGIN_SUCCEEDED,
    summary: `${employee!.firstName} ${employee!.lastName} signed in`,
    contextLabel: `${employee!.firstName} ${employee!.lastName}`,
    actor: { id: employee!.id, label: `${employee!.firstName} ${employee!.lastName}` },
  });

  return { ok: true as const };
}

export async function logout() {
  await destroySession();
  redirect("/login");
}

export async function acceptInvite(data: { token: string; password: string }) {
  const token = data.token.trim();
  const password = data.password;

  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }

  const employee = token
    ? await prisma.employee.findUnique({ where: { inviteToken: token } })
    : null;

  const expired =
    !employee ||
    employee.passwordHash !== null ||
    !employee.inviteTokenExpiresAt ||
    employee.inviteTokenExpiresAt < new Date();

  if (expired) {
    throw new Error(
      "This invite link is invalid or has expired — ask your admin for a new one."
    );
  }

  await prisma.employee.update({
    where: { id: employee!.id },
    data: {
      passwordHash: await hashPassword(password),
      inviteToken: null,
      inviteTokenExpiresAt: null,
      passwordChangedAt: new Date(),
    },
  });

  await recordAudit({
    entityType: "Employee",
    entityId: employee!.id,
    action: AUDIT.INVITE_ACCEPTED,
    summary: `${employee!.firstName} ${employee!.lastName} accepted their invite and set a password`,
    contextLabel: `${employee!.firstName} ${employee!.lastName}`,
    actor: { id: employee!.id, label: `${employee!.firstName} ${employee!.lastName}` },
  });

  await createSession(employee!.id);
  return { ok: true as const };
}

// --- Password reset -----------------------------------------------------------

// Where reset links point. Falls back to the request's own host so this works
// in development without configuration; set APP_URL in a deployment sitting
// behind a proxy, where the Host header may not be the public name.
async function appOrigin(): Promise<string> {
  const configured = process.env.APP_URL?.replace(/\/+$/, "");
  if (configured) return configured;
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

// Not exported: every export from a "use server" module has to be an async
// server action, and this is neither.
function resetUrl(origin: string, token: string): string {
  return `${origin}/reset-password/${token}`;
}

// Step 1: ask for a link.
//
// Always reports the same thing, whatever happened, and never reveals whether
// the address is known. The only externally visible difference is timing, and
// the work either way is a single indexed lookup.
export async function requestPasswordReset(data: { email: string }) {
  const email = data.email.trim().toLowerCase();
  if (!email) throw new Error("Enter your email address.");

  const limit = rateLimit(`reset:${email}`, LIMITS.PASSWORD_RESET);
  if (!limit.ok) {
    // A throttle message is safe to show: it says nothing about whether the
    // account exists, only that this address has been asked for a lot.
    throw new Error(
      `Too many reset requests for that address. Try again in ${Math.ceil(
        limit.retryAfterSeconds / 60
      )} minute(s).`
    );
  }

  const employee = await prisma.employee.findUnique({ where: { email } });

  if (employee) {
    const token = newToken();
    await prisma.employee.update({
      where: { id: employee.id },
      data: {
        resetTokenHash: hashToken(token),
        resetTokenExpiresAt: resetExpiry(),
      },
    });

    const origin = await appOrigin();
    const { subject, body } = renderResetEmail({
      first_name: employee.firstName,
      email: employee.email,
      reset_url: resetUrl(origin, token),
      expires_in: RESET_TTL_LABEL,
      firm_name: firmName(),
    });

    const { delivered } = await sendSystemEmail({
      to: employee.email,
      subject,
      body,
      templateKey: "system:password-reset",
    });

    await recordAudit({
      entityType: "Employee",
      entityId: employee.id,
      action: AUDIT.PASSWORD_RESET_REQUESTED,
      summary: delivered
        ? `Password reset link emailed to ${employee.email}`
        : `Password reset link generated for ${employee.email} — NOT delivered (no mail provider configured)`,
      contextLabel: `${employee.firstName} ${employee.lastName}`,
      actor: { id: null, label: ANONYMOUS_ACTOR },
    });
  }

  return { ok: true as const, message: RESET_ACKNOWLEDGEMENT };
}

// Checks a token without spending it, so the page can show "this link expired"
// instead of a form that fails on submit.
export async function checkResetToken(token: string) {
  const employee = token
    ? await prisma.employee.findUnique({ where: { resetTokenHash: hashToken(token.trim()) } })
    : null;

  if (
    !employee ||
    !employee.resetTokenExpiresAt ||
    employee.resetTokenExpiresAt < new Date()
  ) {
    return { valid: false as const };
  }
  return { valid: true as const, email: employee.email, firstName: employee.firstName };
}

// Step 2: redeem it.
export async function resetPassword(data: { token: string; password: string }) {
  const token = data.token.trim();
  const password = data.password;

  const limit = rateLimit(`reset-redeem:${token.slice(0, 16)}`, LIMITS.RESET_REDEEM);
  if (!limit.ok) throw new Error("Too many attempts. Request a fresh link.");

  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }

  const employee = token
    ? await prisma.employee.findUnique({ where: { resetTokenHash: hashToken(token) } })
    : null;

  if (
    !employee ||
    !employee.resetTokenExpiresAt ||
    employee.resetTokenExpiresAt < new Date()
  ) {
    throw new Error(
      "This reset link is invalid or has expired — request a new one from the sign-in page."
    );
  }

  await prisma.$transaction([
    // Every existing session dies. If the reset happened because the account
    // was compromised, leaving the attacker's session alive would defeat it.
    prisma.session.deleteMany({ where: { employeeId: employee.id } }),
    prisma.employee.update({
      where: { id: employee.id },
      data: {
        passwordHash: await hashPassword(password),
        resetTokenHash: null,
        resetTokenExpiresAt: null,
        // Redeeming a reset also settles an outstanding invite — the account
        // now has a password, so the invite link must stop working.
        inviteToken: null,
        inviteTokenExpiresAt: null,
        passwordChangedAt: new Date(),
      },
    }),
  ]);

  await recordAudit({
    entityType: "Employee",
    entityId: employee.id,
    action: AUDIT.PASSWORD_RESET_COMPLETED,
    summary: `${employee.firstName} ${employee.lastName} reset their password — all other sessions ended`,
    contextLabel: `${employee.firstName} ${employee.lastName}`,
    actor: { id: employee.id, label: `${employee.firstName} ${employee.lastName}` },
  });

  clearRateLimit(`login:${employee.email}`);
  await createSession(employee.id);
  return { ok: true as const };
}

// Admin-side fallback: mint a reset link to hand over directly.
//
// This exists because with no mail provider configured nothing is actually
// delivered, and it mirrors the invite flow the app already has. It is
// admin-only and audited — issuing a link is a way to take over an account,
// so it must leave a trace.
export async function createResetLinkForEmployee(employeeId: string) {
  const user = await getCurrentUser();
  if (!user || user.role !== "ADMIN") {
    throw new Error("Only an admin can create a reset link.");
  }

  const employee = await prisma.employee.findUniqueOrThrow({ where: { id: employeeId } });
  const token = newToken();
  await prisma.employee.update({
    where: { id: employeeId },
    data: { resetTokenHash: hashToken(token), resetTokenExpiresAt: resetExpiry() },
  });

  await recordAudit({
    entityType: "Employee",
    entityId: employeeId,
    action: AUDIT.PASSWORD_RESET_REQUESTED,
    summary: `${user.firstName} ${user.lastName} generated a reset link for ${employee.firstName} ${employee.lastName}`,
    contextLabel: `${employee.firstName} ${employee.lastName}`,
    actor: { id: user.id, label: `${user.firstName} ${user.lastName}` },
  });

  return { url: resetUrl(await appOrigin(), token), expiresIn: RESET_TTL_LABEL };
}
