import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { InviteForm } from "@/components/invite-form";

export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  const employee = token
    ? await prisma.employee.findUnique({ where: { inviteToken: token } })
    : null;

  const invalid =
    !employee ||
    employee.passwordHash !== null ||
    !employee.inviteTokenExpiresAt ||
    employee.inviteTokenExpiresAt < new Date();

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-accent text-sm font-semibold text-white">
            W
          </div>
          <span className="text-sm font-semibold tracking-tight text-ink">Workflow</span>
        </div>
        <div className="rounded-lg border border-line bg-surface p-6 shadow-sm">
          {invalid ? (
            <>
              <h1 className="text-lg font-semibold tracking-tight text-ink">
                This invite link isn&apos;t valid
              </h1>
              <p className="mt-1 text-sm text-ink-muted">
                It may have already been used or expired. Ask your admin to send
                a new one.
              </p>
              <Link
                href="/login"
                className="mt-4 inline-block text-sm text-accent hover:underline"
              >
                Go to sign in
              </Link>
            </>
          ) : (
            <>
              <h1 className="text-lg font-semibold tracking-tight text-ink">
                Set your password
              </h1>
              <p className="mt-1 text-sm text-ink-muted">
                Welcome, {employee!.firstName}. Choose a password to finish
                setting up your account ({employee!.email}).
              </p>
              <InviteForm token={token} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
