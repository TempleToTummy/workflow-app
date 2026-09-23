"use server";

import { revalidatePath } from "next/cache";
import QRCode from "qrcode";
import { prisma } from "@/lib/prisma";
import { requireUser, type CurrentUser } from "@/lib/auth";
import { requireAdminAction } from "@/lib/access";
import { hashPassword, verifyPassword, MIN_PASSWORD_LENGTH } from "@/lib/password";
import { rateLimit, clearRateLimit, LIMITS } from "@/lib/rate-limit";
import { recordAudit, actorFrom, AUDIT } from "@/lib/audit";
import { seal, unseal } from "@/lib/secret-box";
import {
  generateTotpSecret,
  verifyTotp,
  otpauthUri,
  formatSecretForDisplay,
  generateRecoveryCodes,
  hashRecoveryCode,
} from "@/lib/totp";

// Account & security: a person's own password, two-factor authentication and
// signed-in sessions, plus the admin's two escape hatches for somebody else's
// (reset their 2FA, sign them out everywhere).
//
// Anything that weakens an account — turning 2FA off, minting new recovery
// codes, changing the password — asks for the current password again, so a
// laptop left unlocked for a minute isn't enough to take the account over.

function revalidateAccount() {
  revalidatePath("/account");
  revalidatePath("/admin/employees");
  revalidatePath("/activity");
}

async function reauthenticate(user: CurrentUser, password: string) {
  const limit = rateLimit(`reauth:${user.id}`, LIMITS.REAUTH);
  if (!limit.ok) {
    throw new Error(`Too many attempts. Try again in ${Math.ceil(limit.retryAfterSeconds / 60)} minute(s).`);
  }
  const employee = await prisma.employee.findUniqueOrThrow({ where: { id: user.id } });
  if (!employee.passwordHash || !(await verifyPassword(password, employee.passwordHash))) {
    throw new Error("That password isn't right.");
  }
  clearRateLimit(`reauth:${user.id}`);
  return employee;
}

// --- Password -----------------------------------------------------------------

export async function changePassword(input: {
  current: string;
  next: string;
  signOutOthers: boolean;
}) {
  const user = await requireUser();
  await reauthenticate(user, input.current);
  if (input.next.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Your new password needs at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (input.next === input.current) {
    throw new Error("That's the same as your current password.");
  }

  await prisma.employee.update({
    where: { id: user.id },
    data: { passwordHash: await hashPassword(input.next), passwordChangedAt: new Date() },
  });
  let ended = 0;
  if (input.signOutOthers) {
    ended = (
      await prisma.session.deleteMany({ where: { employeeId: user.id, NOT: { id: user.sessionId } } })
    ).count;
  }

  await recordAudit({
    entityType: "Employee",
    entityId: user.id,
    action: AUDIT.PASSWORD_CHANGED,
    summary: `${user.firstName} ${user.lastName} changed their password${
      ended > 0 ? ` and signed out ${ended} other session${ended === 1 ? "" : "s"}` : ""
    }`,
    contextLabel: `${user.firstName} ${user.lastName}`,
    actor: actorFrom(user),
  });
  revalidateAccount();
  return { endedSessions: ended };
}

// --- Two-factor authentication --------------------------------------------------

// Step 1: a fresh secret, stored but NOT yet enforced, and the QR code for it.
// Sign-in is unaffected until confirmTotpSetup proves the app is producing
// codes — otherwise a mis-scanned QR code would lock the person out.
export async function beginTotpSetup() {
  const user = await requireUser();
  const employee = await prisma.employee.findUniqueOrThrow({ where: { id: user.id } });
  if (employee.totpEnabledAt) {
    throw new Error("Two-factor authentication is already on.");
  }
  const secret = generateTotpSecret();
  await prisma.employee.update({
    where: { id: user.id },
    data: { totpSecret: seal(secret), totpLastUsedStep: null, recoveryCodeHashes: null },
  });
  // What the authenticator app lists the entry under. A colon would break the
  // otpauth label format, so it's swapped out.
  const issuer = (process.env.EMAIL_FROM_NAME?.trim() || "Workflow").replace(/:/g, " ");
  const uri = otpauthUri({ secret, account: employee.email, issuer });
  const qrSvg = await QRCode.toString(uri, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
  return { secret: formatSecretForDisplay(secret), uri, qrSvg };
}

// Step 2: the first code from the app turns 2FA on and returns the recovery
// codes — the only time they are ever shown.
export async function confirmTotpSetup(input: { code: string }) {
  const user = await requireUser();
  const employee = await prisma.employee.findUniqueOrThrow({ where: { id: user.id } });
  if (employee.totpEnabledAt) throw new Error("Two-factor authentication is already on.");
  if (!employee.totpSecret) throw new Error("Start the setup again — it expired.");

  const limit = rateLimit(`mfa-setup:${user.id}`, LIMITS.MFA);
  if (!limit.ok) throw new Error("Too many attempts. Wait a few minutes and start again.");

  const result = verifyTotp(unseal(employee.totpSecret), input.code);
  if (!result.ok) {
    throw new Error(
      "That code didn't match. Check the app is showing the code for this account, and that your phone's clock is set automatically."
    );
  }

  const codes = generateRecoveryCodes();
  await prisma.employee.update({
    where: { id: user.id },
    data: {
      totpEnabledAt: new Date(),
      totpLastUsedStep: result.step,
      recoveryCodeHashes: JSON.stringify(codes.map(hashRecoveryCode)),
    },
  });
  clearRateLimit(`mfa-setup:${user.id}`);

  await recordAudit({
    entityType: "Employee",
    entityId: user.id,
    action: AUDIT.MFA_ENABLED,
    summary: `${user.firstName} ${user.lastName} turned on two-factor authentication`,
    contextLabel: `${user.firstName} ${user.lastName}`,
    actor: actorFrom(user),
  });
  revalidateAccount();
  return { recoveryCodes: codes };
}

export async function cancelTotpSetup() {
  const user = await requireUser();
  await prisma.employee.updateMany({
    where: { id: user.id, totpEnabledAt: null },
    data: { totpSecret: null },
  });
  revalidateAccount();
}

export async function disableTotp(input: { password: string }) {
  const user = await requireUser();
  const employee = await reauthenticate(user, input.password);
  if (!employee.totpEnabledAt) return;
  await prisma.employee.update({
    where: { id: user.id },
    data: { totpSecret: null, totpEnabledAt: null, totpLastUsedStep: null, recoveryCodeHashes: null },
  });
  await recordAudit({
    entityType: "Employee",
    entityId: user.id,
    action: AUDIT.MFA_DISABLED,
    summary: `${user.firstName} ${user.lastName} turned off two-factor authentication`,
    contextLabel: `${user.firstName} ${user.lastName}`,
    actor: actorFrom(user),
  });
  revalidateAccount();
}

// New codes replace ALL old ones — used after a few have been spent, or if the
// printed list might have been seen by someone else.
export async function regenerateRecoveryCodes(input: { password: string }) {
  const user = await requireUser();
  const employee = await reauthenticate(user, input.password);
  if (!employee.totpEnabledAt) throw new Error("Turn on two-factor authentication first.");
  const codes = generateRecoveryCodes();
  await prisma.employee.update({
    where: { id: user.id },
    data: { recoveryCodeHashes: JSON.stringify(codes.map(hashRecoveryCode)) },
  });
  await recordAudit({
    entityType: "Employee",
    entityId: user.id,
    action: AUDIT.MFA_ENABLED,
    summary: `${user.firstName} ${user.lastName} generated new recovery codes (the old ones no longer work)`,
    contextLabel: `${user.firstName} ${user.lastName}`,
    actor: actorFrom(user),
  });
  revalidateAccount();
  return { recoveryCodes: codes };
}

// --- Sessions -------------------------------------------------------------------

export async function revokeSession(sessionId: string) {
  const user = await requireUser();
  if (sessionId === user.sessionId) {
    throw new Error("That's this browser — use Sign out instead.");
  }
  // Scoped to the caller's own sessions: a session id alone must never be
  // enough to sign somebody else out.
  const { count } = await prisma.session.deleteMany({ where: { id: sessionId, employeeId: user.id } });
  if (count > 0) {
    await recordAudit({
      entityType: "Employee",
      entityId: user.id,
      action: AUDIT.SESSION_REVOKED,
      summary: `${user.firstName} ${user.lastName} signed out one of their other sessions`,
      contextLabel: `${user.firstName} ${user.lastName}`,
      actor: actorFrom(user),
    });
  }
  revalidateAccount();
}

export async function revokeOtherSessions() {
  const user = await requireUser();
  const { count } = await prisma.session.deleteMany({
    where: { employeeId: user.id, NOT: { id: user.sessionId } },
  });
  if (count > 0) {
    await recordAudit({
      entityType: "Employee",
      entityId: user.id,
      action: AUDIT.SESSION_REVOKED,
      summary: `${user.firstName} ${user.lastName} signed out ${count} other session${count === 1 ? "" : "s"}`,
      contextLabel: `${user.firstName} ${user.lastName}`,
      actor: actorFrom(user),
    });
  }
  revalidateAccount();
  return { ended: count };
}

// --- Admin -----------------------------------------------------------------------

// For a lost phone AND lost recovery codes. Turns 2FA off for that person and
// signs them out everywhere; they sign in with their password and can set it
// up again. Audited, because it removes a protection from an account.
export async function adminResetTwoFactor(employeeId: string) {
  const admin = await requireAdminAction();
  const target = await prisma.employee.findUniqueOrThrow({ where: { id: employeeId } });
  await prisma.$transaction([
    prisma.employee.update({
      where: { id: employeeId },
      data: { totpSecret: null, totpEnabledAt: null, totpLastUsedStep: null, recoveryCodeHashes: null },
    }),
    prisma.session.deleteMany({ where: { employeeId } }),
    prisma.loginChallenge.deleteMany({ where: { employeeId } }),
  ]);
  await recordAudit({
    entityType: "Employee",
    entityId: employeeId,
    action: AUDIT.MFA_RESET,
    summary: `${admin.firstName} ${admin.lastName} reset two-factor authentication for ${target.firstName} ${target.lastName} and signed them out`,
    contextLabel: `${target.firstName} ${target.lastName}`,
    actor: actorFrom(admin),
  });
  revalidateAccount();
}

// Ends every session a person has, without touching their password — for a
// lost laptop, or someone leaving on bad terms before access is revoked.
export async function adminSignOutEverywhere(employeeId: string) {
  const admin = await requireAdminAction();
  const target = await prisma.employee.findUniqueOrThrow({ where: { id: employeeId } });
  const { count } = await prisma.session.deleteMany({
    where: { employeeId, ...(employeeId === admin.id ? { NOT: { id: admin.sessionId } } : {}) },
  });
  await recordAudit({
    entityType: "Employee",
    entityId: employeeId,
    action: AUDIT.SESSION_REVOKED,
    summary: `${admin.firstName} ${admin.lastName} signed ${target.firstName} ${target.lastName} out of ${count} session${
      count === 1 ? "" : "s"
    }`,
    contextLabel: `${target.firstName} ${target.lastName}`,
    actor: actorFrom(admin),
  });
  revalidateAccount();
  return { ended: count };
}
