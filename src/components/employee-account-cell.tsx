"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Role } from "@prisma/client";
import { regenerateInvite, revokeAccess, setEmployeeRole } from "@/lib/actions";
import { createResetLinkForEmployee } from "@/lib/auth-actions";

export function RoleSelect({
  employeeId,
  role,
}: {
  employeeId: string;
  role: Role;
}) {
  const router = useRouter();
  const [value, setValue] = useState<Role>(role);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function change(next: Role) {
    const previous = value;
    setValue(next);
    setError(null);
    startTransition(async () => {
      try {
        await setEmployeeRole(employeeId, next);
        router.refresh();
      } catch (err) {
        setValue(previous);
        setError(err instanceof Error ? err.message : "Couldn't change role.");
      }
    });
  }

  return (
    <div>
      <select
        value={value}
        disabled={isPending}
        onChange={(e) => change(e.target.value as Role)}
        className="rounded-md border border-line bg-surface px-2 py-1 text-sm text-ink disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-accent/40"
      >
        <option value="EMPLOYEE">Employee</option>
        <option value="ADMIN">Admin</option>
      </select>
      {error && <p className="mt-1 text-xs text-overdue">{error}</p>}
    </div>
  );
}

export function AccountCell({
  employeeId,
  hasPassword,
  inviteToken,
}: {
  employeeId: string;
  hasPassword: boolean;
  inviteToken: string | null;
}) {
  const router = useRouter();
  const [token, setToken] = useState(inviteToken);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function inviteUrl(t: string) {
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    return `${origin}/invite/${t}`;
  }

  async function copy(t: string) {
    try {
      await navigator.clipboard.writeText(inviteUrl(t));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("Couldn't copy — the link is in the tooltip.");
    }
  }

  function regenerate() {
    setError(null);
    startTransition(async () => {
      try {
        const { inviteToken: fresh } = await regenerateInvite(employeeId);
        setToken(fresh);
        await copy(fresh);
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't regenerate.");
      }
    });
  }

  function revoke() {
    if (!confirm("Revoke this account's access? Their sessions end immediately and they'll need a new invite.")) {
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        await revokeAccess(employeeId);
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't revoke.");
      }
    });
  }

  if (hasPassword) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <span className="inline-flex items-center rounded-full bg-accent-soft px-2 py-0.5 text-xs font-medium text-accent">
          Active
        </span>
        <ResetLinkButton employeeId={employeeId} />
        <button
          type="button"
          onClick={revoke}
          disabled={isPending}
          className="text-xs text-ink-muted hover:text-overdue disabled:opacity-50"
        >
          Revoke
        </button>
        {error && <p className="w-full text-xs text-overdue">{error}</p>}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="inline-flex items-center rounded-full bg-black/5 px-2 py-0.5 text-xs font-medium text-ink-muted">
        Invite pending
      </span>
      {token ? (
        <>
          <button
            type="button"
            onClick={() => copy(token)}
            // The path, not inviteUrl(): the origin only exists in the browser,
            // so using it here renders differently on the server and trips a
            // hydration mismatch.
            title={`/invite/${token}`}
            className="rounded-full border border-line px-2.5 py-1 text-xs font-medium text-ink hover:bg-black/5"
          >
            {copied ? "Copied!" : "Copy link"}
          </button>
          <button
            type="button"
            onClick={regenerate}
            disabled={isPending}
            className="text-xs text-ink-muted hover:text-accent disabled:opacity-50"
          >
            Regenerate
          </button>
        </>
      ) : (
        <button
          type="button"
          onClick={regenerate}
          disabled={isPending}
          className="rounded-full border border-line px-2.5 py-1 text-xs font-medium text-ink hover:bg-black/5 disabled:opacity-50"
        >
          Create invite link
        </button>
      )}
      {error && <p className="w-full text-xs text-overdue">{error}</p>}
    </div>
  );
}

// Generates a password reset link an admin can hand over directly.
//
// Needed because with no mail provider configured the reset email is recorded
// but not delivered, so without this a forgotten password would still require
// Revoke + re-invite — the exact problem the reset flow was meant to remove.
// It mirrors the invite "Copy link" control next to it. Every use is audited:
// minting one of these is a way to take over an account.
function ResetLinkButton({ employeeId }: { employeeId: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("Couldn't copy — the link is in the tooltip.");
    }
  }

  function generate() {
    setError(null);
    startTransition(async () => {
      try {
        const result = await createResetLinkForEmployee(employeeId);
        setUrl(result.url);
        await copy(result.url);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't create a reset link.");
      }
    });
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={url ? () => copy(url) : generate}
        disabled={isPending}
        title={url ?? "Creates a single-use link, valid for 1 hour"}
        className="rounded-full border border-line px-2.5 py-1 text-xs font-medium text-ink hover:bg-black/5 disabled:opacity-50"
      >
        {isPending ? "Creating…" : copied ? "Copied!" : url ? "Copy reset link" : "Reset password"}
      </button>
      {url && <span className="text-[11px] text-ink-muted">expires in 1 hour</span>}
      {error && <span className="text-xs text-overdue">{error}</span>}
    </span>
  );
}
