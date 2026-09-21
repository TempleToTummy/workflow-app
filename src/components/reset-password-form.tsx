"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { resetPassword } from "@/lib/auth-actions";

const inputClass =
  "w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40";

export function ResetPasswordForm({
  token,
  minLength,
}: {
  token: string;
  minLength: number;
}) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // Checked here for a fast, obvious message; the server enforces the length
  // independently, since this form is not the only way in.
  const tooShort = password.length > 0 && password.length < minLength;
  const mismatch = confirm.length > 0 && password !== confirm;
  const canSubmit =
    !isPending && password.length >= minLength && password === confirm;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      try {
        await resetPassword({ token, password });
        // The reset signs you in, so go straight to the app.
        router.replace("/");
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't reset the password.");
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="mt-4 flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-xs text-ink-muted">New password</span>
        <input
          type="password"
          autoComplete="new-password"
          required
          autoFocus
          value={password}
          disabled={isPending}
          onChange={(e) => setPassword(e.target.value)}
          className={inputClass}
        />
        <span className={`text-xs ${tooShort ? "text-overdue" : "text-ink-muted"}`}>
          At least {minLength} characters.
        </span>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-xs text-ink-muted">Confirm new password</span>
        <input
          type="password"
          autoComplete="new-password"
          required
          value={confirm}
          disabled={isPending}
          onChange={(e) => setConfirm(e.target.value)}
          className={inputClass}
        />
        {mismatch && <span className="text-xs text-overdue">Passwords don&apos;t match.</span>}
      </label>

      {error && <p className="text-sm text-overdue">{error}</p>}

      <p className="text-xs text-ink-muted">
        Setting a new password ends every other session on your account.
      </p>

      <button
        type="submit"
        disabled={!canSubmit}
        className="mt-1 rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
      >
        {isPending ? "Saving…" : "Set new password"}
      </button>
    </form>
  );
}
