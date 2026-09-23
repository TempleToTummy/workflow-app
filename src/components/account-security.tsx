"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  changePassword,
  beginTotpSetup,
  confirmTotpSetup,
  cancelTotpSetup,
  disableTotp,
  regenerateRecoveryCodes,
  revokeSession,
  revokeOtherSessions,
} from "@/lib/account-actions";

const card = "rounded-lg border border-line bg-surface p-6";
const heading = "text-sm font-semibold uppercase tracking-wide text-ink-muted";
const inputClass =
  "mt-1 w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40";
const primary =
  "rounded-full bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50";
const danger =
  "rounded-full bg-overdue px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50";
const secondary =
  "rounded-full border border-line px-4 py-2 text-sm font-medium text-ink hover:bg-black/5 disabled:opacity-50";

function message(err: unknown, fallback: string) {
  return err instanceof Error ? err.message : fallback;
}

// --- Password ------------------------------------------------------------------

export function ChangePasswordCard({ minLength }: { minLength: number }) {
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formEl = e.currentTarget;
    const form = new FormData(formEl);
    const current = String(form.get("current") ?? "");
    const next = String(form.get("next") ?? "");
    const confirm = String(form.get("confirm") ?? "");
    setError(null);
    setDone(null);
    if (next !== confirm) {
      setError("The two new passwords don't match.");
      return;
    }
    startTransition(async () => {
      try {
        const { endedSessions } = await changePassword({
          current,
          next,
          signOutOthers: form.get("signOutOthers") === "on",
        });
        formEl.reset();
        setDone(
          `Password changed.${
            endedSessions > 0 ? ` ${endedSessions} other session${endedSessions === 1 ? " was" : "s were"} signed out.` : ""
          }`
        );
      } catch (err) {
        setError(message(err, "Couldn't change your password."));
      }
    });
  }

  return (
    <div className={card}>
      <h2 className={heading}>Password</h2>
      <form onSubmit={submit} className="mt-4 flex max-w-sm flex-col gap-3">
        <label className="text-xs font-medium text-ink-muted">
          Current password
          <input name="current" type="password" autoComplete="current-password" required className={inputClass} />
        </label>
        <label className="text-xs font-medium text-ink-muted">
          New password
          <input
            name="next"
            type="password"
            autoComplete="new-password"
            required
            minLength={minLength}
            className={inputClass}
          />
          <span className="mt-1 block font-normal">At least {minLength} characters.</span>
        </label>
        <label className="text-xs font-medium text-ink-muted">
          Confirm new password
          <input name="confirm" type="password" autoComplete="new-password" required className={inputClass} />
        </label>
        <label className="flex items-center gap-2 text-sm text-ink">
          <input type="checkbox" name="signOutOthers" defaultChecked />
          Sign out my other devices
        </label>
        {error && <p className="text-sm text-overdue">{error}</p>}
        {done && <p className="text-sm text-accent">{done}</p>}
        <div>
          <button type="submit" disabled={isPending} className={primary}>
            {isPending ? "Saving…" : "Change password"}
          </button>
        </div>
      </form>
    </div>
  );
}

// --- Two-factor ------------------------------------------------------------------

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const text = codes.join("\n");
  return (
    <div className="mt-4 rounded-md border border-[var(--status-review)]/40 bg-[var(--status-review)]/10 p-4">
      <p className="text-sm font-medium text-ink">Save your recovery codes now</p>
      <p className="mt-1 text-sm text-ink-muted">
        If you lose your phone, each of these gets you in once. This is the only time they&apos;re shown — keep
        them somewhere safe, like a password manager or printed in a drawer.
      </p>
      <ol className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 font-mono text-sm text-ink">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ol>
      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          className={secondary}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(text);
              setCopied(true);
            } catch {
              setCopied(false);
            }
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
        <a
          className={secondary}
          download="workflow-recovery-codes.txt"
          href={`data:text/plain;charset=utf-8,${encodeURIComponent(`Workflow recovery codes\n\n${text}\n`)}`}
        >
          Download .txt
        </a>
        <button type="button" className={primary} onClick={onDone}>
          I&apos;ve saved them
        </button>
      </div>
    </div>
  );
}

export function TwoFactorCard({
  enabled,
  enabledAt,
  recoveryRemaining,
  encrypted,
}: {
  enabled: boolean;
  enabledAt: string | null;
  recoveryRemaining: number;
  encrypted: boolean;
}) {
  const router = useRouter();
  const [setup, setSetup] = useState<{ secret: string; qrSvg: string; uri: string } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [confirming, setConfirming] = useState<"disable" | "regenerate" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function run(fn: () => Promise<void>) {
    setError(null);
    startTransition(async () => {
      try {
        await fn();
      } catch (err) {
        setError(message(err, "That didn't work."));
      }
    });
  }

  if (codes) {
    return (
      <div className={card}>
        <h2 className={heading}>Two-factor authentication</h2>
        <RecoveryCodes
          codes={codes}
          onDone={() => {
            setCodes(null);
            router.refresh();
          }}
        />
      </div>
    );
  }

  return (
    <div className={card}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className={heading}>Two-factor authentication</h2>
        <span
          className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
            enabled ? "bg-[var(--status-done-soft)] text-[var(--status-done)]" : "bg-black/5 text-ink-muted"
          }`}
        >
          {enabled ? "On" : "Off"}
        </span>
      </div>

      {!enabled && !setup && (
        <>
          <p className="mt-3 text-sm text-ink-muted">
            Ask for a code from an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password,
            Authy…) after your password. A stolen or guessed password alone is then not enough to get in.
          </p>
          <button
            type="button"
            disabled={isPending}
            className={`${primary} mt-4`}
            onClick={() => run(async () => setSetup(await beginTotpSetup()))}
          >
            {isPending ? "Starting…" : "Set up two-factor"}
          </button>
        </>
      )}

      {!enabled && setup && (
        <div className="mt-4 grid grid-cols-1 gap-6 sm:grid-cols-[auto_1fr]">
          <div>
            <div
              className="h-44 w-44 rounded-md border border-line bg-white p-2 [&>svg]:h-full [&>svg]:w-full"
              role="img"
              aria-label="QR code to scan with your authenticator app"
              dangerouslySetInnerHTML={{ __html: setup.qrSvg }}
            />
            <a href={setup.uri} className="mt-2 block text-center text-xs text-accent hover:underline sm:hidden">
              Open in authenticator app
            </a>
          </div>
          <div>
            <ol className="list-decimal space-y-2 pl-5 text-sm text-ink">
              <li>Open your authenticator app and add an account.</li>
              <li>
                Scan the QR code. Can&apos;t scan? Enter this key instead:
                <span className="mt-1 block select-all rounded bg-black/5 px-2 py-1 font-mono text-xs tracking-wider">
                  {setup.secret}
                </span>
              </li>
              <li>Type the 6-digit code the app shows to finish.</li>
            </ol>
            <form
              className="mt-4 flex flex-wrap items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const code = String(new FormData(e.currentTarget).get("code") ?? "");
                run(async () => {
                  const r = await confirmTotpSetup({ code });
                  setSetup(null);
                  setCodes(r.recoveryCodes);
                });
              }}
            >
              <label className="text-xs font-medium text-ink-muted">
                Code from the app
                <input
                  name="code"
                  required
                  autoFocus
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={7}
                  placeholder="123 456"
                  className={`${inputClass} w-36 tracking-widest`}
                />
              </label>
              <button type="submit" disabled={isPending} className={primary}>
                {isPending ? "Checking…" : "Turn on"}
              </button>
              <button
                type="button"
                disabled={isPending}
                className={secondary}
                onClick={() =>
                  run(async () => {
                    await cancelTotpSetup();
                    setSetup(null);
                  })
                }
              >
                Cancel
              </button>
            </form>
          </div>
        </div>
      )}

      {enabled && (
        <>
          <p className="mt-3 text-sm text-ink-muted">
            On since {enabledAt ? new Date(enabledAt).toLocaleDateString() : "—"}. You&apos;ll be asked for a code
            from your authenticator app each time you sign in.
          </p>
          <p className={`mt-2 text-sm ${recoveryRemaining <= 3 ? "font-medium text-overdue" : "text-ink-muted"}`}>
            {recoveryRemaining} of 10 recovery codes left.
            {recoveryRemaining <= 3 && " Generate new ones so you can't get locked out."}
          </p>

          {confirming ? (
            <form
              className="mt-4 flex max-w-sm flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const password = String(new FormData(e.currentTarget).get("password") ?? "");
                run(async () => {
                  if (confirming === "disable") {
                    await disableTotp({ password });
                    setConfirming(null);
                    router.refresh();
                  } else {
                    const r = await regenerateRecoveryCodes({ password });
                    setConfirming(null);
                    setCodes(r.recoveryCodes);
                  }
                });
              }}
            >
              <label className="text-xs font-medium text-ink-muted">
                {confirming === "disable"
                  ? "Enter your password to turn two-factor off"
                  : "Enter your password to replace your recovery codes"}
                <input name="password" type="password" autoComplete="current-password" required autoFocus className={inputClass} />
              </label>
              <div className="flex gap-2">
                <button type="submit" disabled={isPending} className={confirming === "disable" ? danger : primary}>
                  {confirming === "disable" ? "Turn off" : "Generate new codes"}
                </button>
                <button type="button" className={secondary} onClick={() => setConfirming(null)}>
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <div className="mt-4 flex flex-wrap gap-2">
              <button type="button" className={secondary} onClick={() => setConfirming("regenerate")}>
                New recovery codes
              </button>
              <button type="button" className={secondary} onClick={() => setConfirming("disable")}>
                Turn off two-factor
              </button>
            </div>
          )}
        </>
      )}

      {!encrypted && (
        <p className="mt-4 text-xs text-ink-muted">
          Note for your administrator: AUTH_SECRET isn&apos;t set, so two-factor secrets are stored unencrypted. Set it
          in the server environment to encrypt them.
        </p>
      )}
      {error && <p className="mt-3 text-sm text-overdue">{error}</p>}
    </div>
  );
}

// --- Sessions ----------------------------------------------------------------------

export type SessionRow = {
  id: string;
  device: string;
  ip: string;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
};

function ago(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 5) return "Active now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} h ago`;
  return new Date(iso).toLocaleDateString();
}

export function SessionsCard({ sessions }: { sessions: SessionRow[] }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const others = sessions.filter((s) => !s.current);

  function run(fn: () => Promise<unknown>) {
    setError(null);
    startTransition(async () => {
      try {
        await fn();
        router.refresh();
      } catch (err) {
        setError(message(err, "That didn't work."));
      }
    });
  }

  return (
    <div className={card}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className={heading}>Where you&apos;re signed in</h2>
        {others.length > 0 && (
          <button
            type="button"
            disabled={isPending}
            onClick={() => {
              if (window.confirm(`Sign out of ${others.length} other session${others.length === 1 ? "" : "s"}?`)) {
                run(revokeOtherSessions);
              }
            }}
            className={secondary}
          >
            Sign out all other sessions
          </button>
        )}
      </div>
      <p className="mt-1 text-sm text-ink-muted">
        Don&apos;t recognise one? Sign it out, then change your password.
      </p>
      <ul className="mt-4 divide-y divide-line">
        {sessions.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
            <div>
              <p className="text-sm font-medium text-ink">
                {s.device}
                {s.current && (
                  <span className="ml-2 rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-medium text-accent">
                    This browser
                  </span>
                )}
              </p>
              <p className="text-xs text-ink-muted">
                {s.ip} · signed in {new Date(s.createdAt).toLocaleDateString()} · {s.current ? "Active now" : ago(s.lastSeenAt)}
              </p>
            </div>
            {!s.current && (
              <button
                type="button"
                disabled={isPending}
                onClick={() => run(() => revokeSession(s.id))}
                className="text-sm text-ink-muted hover:text-overdue disabled:opacity-50"
              >
                Sign out
              </button>
            )}
          </li>
        ))}
      </ul>
      {error && <p className="mt-2 text-sm text-overdue">{error}</p>}
    </div>
  );
}
