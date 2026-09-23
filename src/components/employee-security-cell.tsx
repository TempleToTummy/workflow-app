"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { adminResetTwoFactor, adminSignOutEverywhere } from "@/lib/account-actions";

// Admin → Employees: someone's 2FA status and signed-in sessions, with the two
// escape hatches — reset 2FA (lost phone and lost recovery codes) and sign out
// everywhere (lost laptop).
export function EmployeeSecurityCell({
  employeeId,
  name,
  twoFactor,
  sessions,
  isSelf,
}: {
  employeeId: string;
  name: string;
  twoFactor: boolean;
  sessions: number;
  isSelf: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function run(question: string, fn: () => Promise<unknown>) {
    if (!window.confirm(question)) return;
    setError(null);
    startTransition(async () => {
      try {
        await fn();
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "That didn't work.");
      }
    });
  }

  return (
    <div className="mt-1.5 flex flex-col gap-1 text-xs">
      <div className="flex flex-wrap items-center gap-2 text-ink-muted">
        <span
          className={`rounded-full px-1.5 py-0.5 font-medium ${
            twoFactor ? "bg-[var(--status-done-soft)] text-[var(--status-done)]" : "bg-black/5"
          }`}
        >
          2FA {twoFactor ? "on" : "off"}
        </span>
        <span>
          {sessions} active session{sessions === 1 ? "" : "s"}
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        {twoFactor && !isSelf && (
          <button
            type="button"
            disabled={isPending}
            onClick={() =>
              run(
                `Reset two-factor authentication for ${name}?\n\nUse this when they've lost their phone and their recovery codes. They'll be signed out and can sign in with just their password, then set 2FA up again.`,
                () => adminResetTwoFactor(employeeId)
              )
            }
            className="text-accent hover:underline disabled:opacity-50"
          >
            Reset 2FA
          </button>
        )}
        {sessions > 0 && (
          <button
            type="button"
            disabled={isPending}
            onClick={() =>
              run(
                isSelf
                  ? "Sign yourself out on every other device? This browser stays signed in."
                  : `Sign ${name} out on every device? Their password isn't changed.`,
                () => adminSignOutEverywhere(employeeId)
              )
            }
            className="text-accent hover:underline disabled:opacity-50"
          >
            Sign out everywhere
          </button>
        )}
      </div>
      {error && <span className="text-overdue">{error}</span>}
    </div>
  );
}
