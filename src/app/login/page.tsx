import { redirect } from "next/navigation";
import { LoginForm } from "@/components/login-form";
import { getCurrentUser } from "@/lib/auth";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  // Send a genuinely signed-in user to the app. This check lives here rather
  // than in src/proxy.ts because it needs the real session, not just the
  // presence of a cookie: a stale cookie redirected from the proxy would ping
  // -pong against requireUser() forever. Falling through to the form is the
  // safe outcome — the worst case is someone signs in again.
  const user = await getCurrentUser();
  if (user) redirect("/");

  const { next } = await searchParams;
  // Only keep an app-internal path.
  const safeNext = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";

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
          <h1 className="text-lg font-semibold tracking-tight text-ink">Sign in</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Use the email and password for your account.
          </p>
          <LoginForm next={safeNext} />
        </div>
      </div>
    </div>
  );
}
