"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { discardRunningTimer, stopRunningTimer } from "@/lib/time-actions";
import { formatElapsed, formatMinutes } from "@/lib/time";
import { useElapsedSeconds } from "@/components/task-timer";

// The running timer, pinned in the sidebar.
//
// Without this, a timer is only stoppable from the page it was started on,
// which is how people end up with a clock running over a weekend. It sits in
// the sidebar because that is the one thing on screen everywhere.
//
// "Discard" is next to "Stop" on purpose: the most common timer mistake is
// starting one on the wrong task, and the fix for that is to delete it, not to
// log a minute and then go and find it in a list to delete. It's only ever
// offered for a RUNNING timer, so it can't be used to erase recorded time.
export function RunningTimerBar({
  startedAt,
  label,
  href,
}: {
  startedAt: string;
  label: string;
  href: string | null;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const elapsed = useElapsedSeconds(startedAt);

  function run(action: () => Promise<unknown>, fallback: string) {
    setError(null);
    startTransition(async () => {
      try {
        await action();
        setConfirmDiscard(false);
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : fallback);
      }
    });
  }

  return (
    <div className="no-print mx-3 mb-2 rounded-md border border-sidebar-border bg-sidebar-hover px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[11px] font-medium tracking-wide text-sidebar-active-ink uppercase">
          <span className="relative flex h-1.5 w-1.5">
            {/* A pulsing dot is the cheapest possible "this is live". */}
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sidebar-active-ink opacity-60" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-sidebar-active-ink" />
          </span>
          Timing
        </span>
        <span className="tabular text-sm text-sidebar-ink">{formatElapsed(elapsed)}</span>
      </div>

      {href ? (
        <Link href={href} className="mt-1 block truncate text-xs text-sidebar-ink hover:underline">
          {label}
        </Link>
      ) : (
        <p className="mt-1 truncate text-xs text-sidebar-ink">{label}</p>
      )}

      <div className="mt-2 flex items-center gap-1.5">
        <button
          type="button"
          disabled={isPending}
          onClick={() => run(stopRunningTimer, "Couldn't stop the timer.")}
          className="flex-1 rounded-full bg-sidebar-active-ink px-2 py-1 text-[11px] font-medium text-sidebar-bg hover:opacity-90 disabled:opacity-50"
        >
          {isPending ? "…" : "Stop & log"}
        </button>
        <button
          type="button"
          disabled={isPending}
          onClick={() => {
            // Two-step, because this one throws work away. The elapsed time is
            // named in the confirmation so nobody discards forty minutes
            // thinking they're discarding forty seconds.
            if (!confirmDiscard) {
              setConfirmDiscard(true);
              return;
            }
            run(discardRunningTimer, "Couldn't discard the timer.");
          }}
          title={
            confirmDiscard
              ? `Discard ${formatMinutes(Math.floor(elapsed / 60))} without logging it`
              : "Started this by mistake? Discard it."
          }
          className={`rounded-full border px-2 py-1 text-[11px] font-medium transition-colors disabled:opacity-50 ${
            confirmDiscard
              ? "border-transparent bg-overdue text-white"
              : "border-sidebar-border text-sidebar-ink-muted hover:text-sidebar-ink"
          }`}
        >
          {confirmDiscard ? "Discard?" : "Discard"}
        </button>
      </div>

      {error && <p className="mt-1.5 text-[11px] text-overdue">{error}</p>}
    </div>
  );
}
