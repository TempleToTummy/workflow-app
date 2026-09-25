"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { requestPasswordReset } from "@/lib/auth-actions";

const inputClass =
  "w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40";

export function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      try {
        const result = await requestPasswordReset({ email });
        // The same acknowledgement regardless of whether the account exists —
        // the form must not reveal who has an account here.
        setSent(result.message);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't send a reset link.");
      }
    });
  }

  if (sent) {
    return (
      <div className="mt-4">
        <p className="rounded-md border border-accent/30 bg-accent-soft px-3 py-2.5 text-sm text-accent">
          {sent}
        </p>
        <p className="mt-3 text-xs text-ink-muted">
          The link expires in 1 hour and can only be used once. If nothing arrives,
          check your spam folder or ask an administrator to send you one directly.
        </p>
        <Link
          href="/login"
          className="mt-4 inline-block text-sm text-accent hover:underline"
        >
          ← Back to sign in
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="mt-4 flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-xs text-ink-muted">Email</span>
        <input
          type="email"
          name="email"
          autoComplete="email"
          required
          autoFocus
          value={email}
          disabled={isPending}
          onChange={(e) => setEmail(e.target.value)}
          className={inputClass}
        />
      </label>

      {error && <p className="text-sm text-overdue">{error}</p>}

      <button
        type="submit"
        disabled={isPending || !email.trim()}
        className="mt-1 whitespace-nowrap rounded-full bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
      >
        {isPending ? "Sending…" : "Send reset link"}
      </button>

      <Link href="/login" className="text-center text-sm text-ink-muted hover:text-accent">
        Back to sign in
      </Link>
    </form>
  );
}
