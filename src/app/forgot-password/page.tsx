import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { ForgotPasswordForm } from "@/components/forgot-password-form";

// Public. Reachable without a session, so it's in PUBLIC_PREFIXES in
// src/proxy.ts alongside /login and /invite.
export default async function ForgotPasswordPage() {
  const user = await getCurrentUser();
  if (user) redirect("/");

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
          <h1 className="text-lg font-semibold tracking-tight text-ink">
            Reset your password
          </h1>
          <p className="mt-1 text-sm text-ink-muted">
            Enter your email and we&apos;ll send you a link to choose a new password.
          </p>
          <ForgotPasswordForm />
        </div>
      </div>
    </div>
  );
}
