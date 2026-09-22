"use client";

import { useCallback, useState, useSyncExternalStore, useTransition } from "react";
import { useRouter } from "next/navigation";
import { startTimer, stopRunningTimer } from "@/lib/time-actions";
import { formatElapsed, formatMinutes } from "@/lib/time";

// The start/stop control on a checklist step.
//
// Two details that make a timer usable rather than merely present:
//
//   1. The elapsed clock ticks locally from `runningSince` rather than being
//      polled. A timer that only moves when the page revalidates doesn't look
//      like a timer, and polling the server once a second for a number the
//      browser can compute itself would be pure waste.
//   2. Starting here stops whatever else was running and SAYS SO. The server
//      action returns what it stopped (see startTimer), so switching tasks —
//      which is what people actually do all day — never silently loses the
//      block of time you were part-way through.

export function TaskTimer({
  activityId,
  // The ISO start time when THIS step's timer is the one running, else null.
  runningSince,
  // Minutes already logged against this step by anyone, for the label.
  loggedMinutes,
  // True when a timer is running on some OTHER task, so the button can say
  // what pressing it will do.
  otherRunning,
  disabled = false,
}: {
  activityId: string;
  runningSince: string | null;
  loggedMinutes: number;
  otherRunning: boolean;
  disabled?: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const elapsed = useElapsedSeconds(runningSince);

  function handleStart() {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      try {
        const result = await startTimer(activityId);
        if (result.stopped) {
          setNotice(
            `Stopped your timer on ${result.stopped.label} — ${formatMinutes(
              result.stopped.minutes
            )} logged.`
          );
        }
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't start the timer.");
      }
    });
  }

  function handleStop() {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      try {
        const result = await stopRunningTimer();
        if (result) {
          setNotice(
            result.capped
              ? `Logged ${formatMinutes(result.minutes)} — the timer had been left running, so this is a ceiling. Please correct it.`
              : `Logged ${formatMinutes(result.minutes)}.`
          );
        }
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't stop the timer.");
      }
    });
  }

  const running = runningSince !== null;

  return (
    <span className="no-print flex shrink-0 flex-col items-end gap-0.5">
      <span className="flex items-center gap-1.5">
        {loggedMinutes > 0 && (
          <span
            className="tabular text-[11px] text-ink-muted"
            title={`${formatMinutes(loggedMinutes)} logged against this step`}
          >
            {formatMinutes(loggedMinutes)}
          </span>
        )}
        <button
          type="button"
          disabled={disabled || isPending}
          onClick={running ? handleStop : handleStart}
          title={
            running
              ? "Stop the timer and log the time"
              : otherRunning
                ? "Start timing this step — your current timer will be stopped and logged"
                : "Start timing this step"
          }
          aria-label={running ? "Stop timer" : "Start timer"}
          className={`tabular inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[11px] font-medium transition-colors disabled:opacity-50 ${
            running
              ? "border-[var(--status-done)] bg-[var(--status-done-soft)] text-[var(--status-done)]"
              : "border-line text-ink-muted hover:border-ink-muted/40 hover:text-ink"
          }`}
        >
          {running ? (
            <>
              <svg viewBox="0 0 20 20" className="h-2.5 w-2.5" fill="currentColor" aria-hidden>
                <rect x="5" y="5" width="10" height="10" rx="1.5" />
              </svg>
              {formatElapsed(elapsed)}
            </>
          ) : (
            <>
              <svg viewBox="0 0 20 20" className="h-2.5 w-2.5" fill="currentColor" aria-hidden>
                <path d="M6 4.5l9 5.5-9 5.5z" />
              </svg>
              Start
            </>
          )}
        </button>
      </span>
      {notice && <span className="max-w-60 text-right text-[11px] text-ink-muted">{notice}</span>}
      {error && <span className="max-w-60 text-right text-[11px] text-overdue">{error}</span>}
    </span>
  );
}

// Seconds since `since`, ticking once a second. Returns 0 when nothing is
// running.
//
// This uses useSyncExternalStore rather than useState + useEffect because the
// wall clock IS an external store, and that framing solves three problems at
// once:
//   - No setState in an effect body, so no cascading render on mount.
//   - No interval at all while nothing is running: `subscribe` returns a no-op
//     teardown, which matters when nine checklist steps each render one of
//     these.
//   - No hydration mismatch. getServerSnapshot returns 0, so the server and
//     the hydrating client agree, and the real elapsed time appears on the
//     first tick afterwards.
export function useElapsedSeconds(since: string | null): number {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!since) return () => {};
      const id = window.setInterval(onChange, 1000);
      return () => window.clearInterval(id);
    },
    [since]
  );

  // Whole seconds, so the snapshot is stable across re-renders within the same
  // second — React compares snapshots with Object.is and would loop on a value
  // that changed every call.
  const nowSeconds = useSyncExternalStore(
    subscribe,
    () => Math.floor(Date.now() / 1000),
    () => 0
  );

  if (!since) return 0;
  const startedAt = Math.floor(new Date(since).getTime() / 1000);
  if (!Number.isFinite(startedAt)) return 0;
  return Math.max(0, nowSeconds - startedAt);
}
