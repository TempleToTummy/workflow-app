"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { login } from "@/lib/auth-actions";

const inputClass =
  "mt-1 w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40";

export function LoginForm({ next }: { next: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const form = new FormData(e.currentTarget);
    const email = String(form.get("email") ?? "");
    const password = String(form.get("password") ?? "");
    startTransition(async () => {
      try {
        await login({ email, password });
        router.replace(next);
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't sign in.");
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="mt-4 flex flex-col gap-3">
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
        className="mt-1 rounded-full bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
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
