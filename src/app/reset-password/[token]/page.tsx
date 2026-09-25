import Link from "next/link";
import { checkResetToken } from "@/lib/auth-actions";
import { ResetPasswordForm } from "@/components/reset-password-form";
import { MIN_PASSWORD_LENGTH } from "@/lib/password";

// Public, like /invite/[token]. The token is checked before rendering so an
// expired link says so plainly instead of showing a form that fails on submit.
export default async function ResetPasswordPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const check = await checkResetToken(token);

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
          {check.valid ? (
            <>
              <h1 className="text-lg font-semibold tracking-tight text-ink">
                Choose a new password
              </h1>
              <p className="mt-1 text-sm text-ink-muted">
                For <span className="font-medium text-ink">{check.email}</span>.
              </p>
              <ResetPasswordForm token={token} minLength={MIN_PASSWORD_LENGTH} />
            </>
          ) : (
            <>
              <h1 className="text-lg font-semibold tracking-tight text-ink">
                This link has expired
              </h1>
              <p className="mt-1 text-sm text-ink-muted">
                Reset links last 1 hour and can only be used once. Request a fresh
                one — or ask an administrator to send you a link directly.
              </p>
              <Link
                href="/forgot-password"
                className="mt-4 inline-block whitespace-nowrap rounded-full bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90"
              >
                Request a new link
              </Link>
              <Link
                href="/login"
                className="mt-3 block text-sm text-ink-muted hover:text-accent"
              >
                ← Back to sign in
              </Link>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
