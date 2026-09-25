"use client";

import Link from "next/link";
import { useEffect } from "react";

// The shared body of every error.tsx in the app.
//
// Before this there was no error.tsx, loading.tsx or not-found.tsx anywhere in
// src/app, so anything that threw during a render — a Prisma unique violation,
// a stale reorder, a period that vanished under a request — gave the user a
// blank crash with no way back. status-select.tsx caught and displayed its own
// errors, and was the only thing in the app that did.
//
// Each route group's error.tsx is now three lines that render this, which
// matters for a reason beyond brevity: the recovery affordances (retry, a link
// out, the digest to quote when reporting it) are identical everywhere, so
// nobody has to decide per route what a crash should look like.
//
// Note on the retry prop: in this version of Next the error boundary receives
// `retry`, not the `reset` older versions passed. `retry()` re-fetches and
// re-renders the segment, which is what you want for a failed query; `reset`
// only clears the error state without re-fetching, so it tends to fail again
// immediately. See node_modules/next/dist/docs/01-app/03-api-reference/
// 03-file-conventions/error.md.
export function ErrorState({
  error,
  retry,
  title,
  description,
  backHref = "/",
  backLabel = "Back to dashboard",
}: {
  error: Error & { digest?: string };
  retry: () => void;
  title: string;
  description?: string;
  backHref?: string;
  backLabel?: string;
}) {
  useEffect(() => {
    // The server log is the only place a stack trace exists in production, so
    // this is what connects the digest the user can see to the detail an
    // administrator needs.
    console.error(`[${title}]`, error);
  }, [error, title]);

  return (
    <div className="mx-auto w-full max-w-2xl px-6 py-16">
      <div className="rounded-lg border border-overdue/30 bg-overdue-soft/40 p-6">
        <div className="flex items-start gap-3">
          <svg viewBox="0 0 20 20" className="mt-0.5 h-5 w-5 shrink-0 text-overdue" fill="none" aria-hidden>
            <circle cx="10" cy="10" r="7.5" stroke="currentColor" strokeWidth="1.5" />
            <path d="M10 6.5v4.2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            <circle cx="10" cy="13.7" r="0.9" fill="currentColor" />
          </svg>
          <div className="min-w-0">
            <h1 className="text-lg font-semibold tracking-tight text-ink">{title}</h1>
            <p className="mt-1 text-sm text-ink-muted">
              {description ??
                "Something went wrong loading this page. Nothing you were working on has been lost."}
            </p>

            {/* The message is shown because this is an internal tool used by a
                handful of colleagues, and "That Tax ID is already in use by
                another client" is exactly the sentence that tells them what to
                do next. A public app would hide it. */}
            {error.message && (
              <p className="mt-3 rounded-md border border-line bg-surface px-3 py-2 text-xs text-ink">
                {error.message}
              </p>
            )}

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => retry()}
                className="whitespace-nowrap rounded-full bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90"
              >
                Try again
              </button>
              <Link
                href={backHref}
                className="rounded-full border border-line bg-surface px-4 py-2 text-sm font-medium text-ink hover:bg-black/5"
              >
                {backLabel}
              </Link>
            </div>

            {/* The digest is the only handle on a production stack trace, so
                it's shown rather than logged and forgotten. */}
            {error.digest && (
              <p className="tabular mt-4 text-[11px] text-ink-muted">
                Reference: {error.digest}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// The body of every not-found.tsx. A missing record and a mistyped URL land
// here, so the wording covers both without guessing which happened.
export function NotFoundState({
  title = "Not found",
  description = "That page or record isn't here. It may have been removed, or the link may be wrong.",
  backHref = "/",
  backLabel = "Back to dashboard",
}: {
  title?: string;
  description?: string;
  backHref?: string;
  backLabel?: string;
}) {
  return (
    <div className="mx-auto w-full max-w-2xl px-6 py-16">
      <div className="rounded-lg border border-line bg-surface p-6">
        <h1 className="text-lg font-semibold tracking-tight text-ink">{title}</h1>
        <p className="mt-1 text-sm text-ink-muted">{description}</p>
        <Link
          href={backHref}
          className="mt-4 inline-block rounded-full border border-line px-4 py-2 text-sm font-medium text-ink hover:bg-black/5"
        >
          {backLabel}
        </Link>
      </div>
    </div>
  );
}
