"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { login, verifyLoginCode, cancelLoginChallenge } from "@/lib/auth-actions";

const inputClass =
  "mt-1 w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40";

// Sign-in, in one or two steps: email + password, then — for accounts with
// two-factor authentication — a code from the authenticator app (or a
// recovery code).
export function LoginForm({
  next,
  initialStep = "password",
}: {
  next: string;
  // "code" when the page found a half-finished two-factor sign-in (e.g. after
  // a password reset on an account with 2FA).
  initialStep?: "password" | "code";
}) {
  const router = useRouter();
  const [step, setStep] = useState<"password" | "code">(initialStep);
  const [useRecovery, setUseRecovery] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function finish() {
    router.replace(next);
    router.refresh();
  }

  function handlePassword(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const form = new FormData(e.currentTarget);
    const email = String(form.get("email") ?? "");
    const password = String(form.get("password") ?? "");
    startTransition(async () => {
      try {
        const result = await login({ email, password });
        if (result.mfaRequired) {
          setStep("code");
          return;
        }
        finish();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't sign in.");
      }
    });
  }

  function handleCode(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const code = String(new FormData(e.currentTarget).get("code") ?? "");
    startTransition(async () => {
      try {
        const result = await verifyLoginCode({ code });
        if (result.remainingRecoveryCodes !== null && result.remainingRecoveryCodes <= 3) {
          // Say it before leaving the page — running out of recovery codes is
          // how people get locked out.
          setNotice(
            `Signed in. You have ${result.remainingRecoveryCodes} recovery code${
              result.remainingRecoveryCodes === 1 ? "" : "s"
            } left — make new ones from your Account page.`
          );
          setTimeout(finish, 2500);
          return;
        }
        finish();
      } catch (err) {
        const message = err instanceof Error ? err.message : "Couldn't verify that code.";
        setError(message);
        if (/sign in again|timed out|Enter your email/i.test(message)) setStep("password");
      }
    });
  }

  function back() {
    setError(null);
    setUseRecovery(false);
    startTransition(async () => {
      await cancelLoginChallenge();
      setStep("password");
    });
  }

  if (step === "code") {
    return (
      <form onSubmit={handleCode} className="mt-4 flex flex-col gap-3">
        <p className="text-sm text-ink">
          {useRecovery
            ? "Enter one of the recovery codes you saved when you set up two-factor authentication. Each code works once."
            : "Enter the 6-digit code from your authenticator app."}
        </p>
        <label className="block text-xs font-medium text-ink-muted">
          {useRecovery ? "Recovery code" : "Authentication code"}
          <input
            key={useRecovery ? "recovery" : "totp"}
            name="code"
            required
            autoFocus
            disabled={isPending || notice !== null}
            autoComplete={useRecovery ? "off" : "one-time-code"}
            inputMode={useRecovery ? "text" : "numeric"}
            pattern={useRecovery ? undefined : "[0-9 ]{6,7}"}
            maxLength={useRecovery ? 16 : 7}
            placeholder={useRecovery ? "XXXXX-XXXXX" : "123 456"}
            className={`${inputClass} tabular tracking-widest`}
          />
        </label>
        {error && <p className="text-xs text-overdue">{error}</p>}
        {notice && <p className="text-xs text-accent">{notice}</p>}
        <button
          type="submit"
          disabled={isPending || notice !== null}
          className="mt-1 whitespace-nowrap rounded-full bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {isPending ? "Checking…" : "Verify"}
        </button>
        <div className="flex items-center justify-between text-xs">
          <button type="button" onClick={back} disabled={isPending} className="text-ink-muted hover:text-accent">
            ← Back
          </button>
          <button
            type="button"
            onClick={() => {
              setUseRecovery((r) => !r);
              setError(null);
            }}
            className="text-ink-muted hover:text-accent"
          >
            {useRecovery ? "Use an authenticator code" : "Lost your phone? Use a recovery code"}
          </button>
        </div>
      </form>
    );
  }

  return (
    <form onSubmit={handlePassword} className="mt-4 flex flex-col gap-3">
      <label className="block text-xs font-medium text-ink-muted">
        Email
        <input
          name="email"
          type="email"
          autoComplete="username"
          required
          disabled={isPending}
          className={inputClass}
        />
      </label>
      <label className="block text-xs font-medium text-ink-muted">
        Password
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          required
          disabled={isPending}
          className={inputClass}
        />
      </label>
      {error && <p className="text-xs text-overdue">{error}</p>}
      <button
        type="submit"
        disabled={isPending}
        className="mt-1 whitespace-nowrap rounded-full bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
      >
        {isPending ? "Signing in…" : "Sign in"}
      </button>
      <a
        href="/forgot-password"
        className="text-center text-xs text-ink-muted hover:text-accent"
      >
        Forgot your password?
      </a>
    </form>
  );
}
