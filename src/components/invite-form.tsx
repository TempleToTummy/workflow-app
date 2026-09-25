"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { acceptInvite } from "@/lib/auth-actions";

const MIN = 8;
const inputClass =
  "mt-1 w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40";

export function InviteForm({ token }: { token: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const form = new FormData(e.currentTarget);
    const password = String(form.get("password") ?? "");
    const confirm = String(form.get("confirm") ?? "");
    if (password.length < MIN) {
      setError(`Password must be at least ${MIN} characters.`);
      return;
    }
    if (password !== confirm) {
      setError("The two passwords don't match.");
      return;
    }
    startTransition(async () => {
      try {
        await acceptInvite({ token, password });
        router.replace("/");
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't set your password.");
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="mt-4 flex flex-col gap-3">
      <label className="block text-xs font-medium text-ink-muted">
        Password
        <input
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={MIN}
          disabled={isPending}
          className={inputClass}
        />
      </label>
      <label className="block text-xs font-medium text-ink-muted">
        Confirm password
        <input
          name="confirm"
          type="password"
          autoComplete="new-password"
          required
          minLength={MIN}
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
        {isPending ? "Saving…" : "Set password & sign in"}
      </button>
    </form>
  );
}
