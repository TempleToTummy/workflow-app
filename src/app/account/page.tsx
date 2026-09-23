import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { MIN_PASSWORD_LENGTH } from "@/lib/password";
import { recoveryCodesRemaining } from "@/lib/totp";
import { isEncryptionConfigured } from "@/lib/secret-box";
import { describeUserAgent, displayIp } from "@/lib/user-agent";
import { ChangePasswordCard, TwoFactorCard, SessionsCard } from "@/components/account-security";

// Account & security — every signed-in user's own page.
export default async function AccountPage() {
  const user = await requireUser();
  const [employee, sessions] = await Promise.all([
    prisma.employee.findUniqueOrThrow({
      where: { id: user.id },
      select: {
        email: true,
        role: true,
        passwordChangedAt: true,
        totpEnabledAt: true,
        recoveryCodeHashes: true,
        employeeType: { select: { name: true } },
      },
    }),
    prisma.session.findMany({
      where: { employeeId: user.id, expiresAt: { gt: new Date() } },
      orderBy: { lastSeenAt: "desc" },
    }),
  ]);

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Account &amp; security</h1>
      <p className="mt-1 text-sm text-ink-muted">
        {user.firstName} {user.lastName} · {employee.email} ·{" "}
        {employee.role === "ADMIN" ? "Admin" : "Employee"}
        {employee.employeeType ? ` · ${employee.employeeType.name}` : ""}
      </p>
      {employee.role === "ADMIN" && !employee.totpEnabledAt && (
        <p className="mt-4 rounded-lg border border-[var(--status-review)]/40 bg-[var(--status-review)]/10 px-4 py-3 text-sm text-ink">
          Your account can see every client and change anyone&apos;s access. Turning on two-factor authentication
          below is strongly recommended.
        </p>
      )}

      <div className="mt-6 flex flex-col gap-6">
        <TwoFactorCard
          enabled={Boolean(employee.totpEnabledAt)}
          enabledAt={employee.totpEnabledAt?.toISOString() ?? null}
          recoveryRemaining={recoveryCodesRemaining(employee.recoveryCodeHashes)}
          encrypted={isEncryptionConfigured()}
        />
        <SessionsCard
          sessions={sessions.map((s) => ({
            id: s.id,
            device: describeUserAgent(s.userAgent),
            ip: displayIp(s.ipAddress),
            createdAt: s.createdAt.toISOString(),
            lastSeenAt: s.lastSeenAt.toISOString(),
            current: s.id === user.sessionId,
          }))}
        />
        <ChangePasswordCard minLength={MIN_PASSWORD_LENGTH} />
        {employee.passwordChangedAt && (
          <p className="-mt-3 text-xs text-ink-muted">
            Password last changed {employee.passwordChangedAt.toLocaleDateString()}.
          </p>
        )}
      </div>
    </div>
  );
}
