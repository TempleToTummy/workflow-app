"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { runPeriodGeneration } from "@/lib/actions";

type Summary = Awaited<ReturnType<typeof runPeriodGeneration>>;

// The "Run now" control on the Work Generation page. Runs the same job cron
// runs and reports what it actually did, so an admin can confirm the schedule
// works without going to read logs.
export function SchedulerPanel({ stale }: { stale: boolean }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);

  function handleRun() {
    setError(null);
    setResult(null);
    startTransition(async () => {
      try {
        const summary = await runPeriodGeneration();
        setResult(summary);
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't run work generation.");
      }
    });
  }

  return (
    <div
      className={`rounded-lg border p-4 ${
        stale ? "border-overdue/40 bg-overdue/5" : "border-line bg-surface"
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-ink">
            {stale ? "Work generation is overdue" : "Run work generation"}
          </h2>
          <p className="mt-1 max-w-xl text-xs text-ink-muted">
            Opens the current accounting period for every active engagement and
            generates its checklist, whether or not the previous period was
            finished. Safe to run as often as you like — it only creates what is
            missing.
          </p>
        </div>
        <button
          type="button"
          onClick={handleRun}
          disabled={isPending}
          className="shrink-0 rounded-full bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {isPending ? "Running…" : "Run now"}
        </button>
      </div>

      {error && <p className="mt-3 text-sm text-overdue">{error}</p>}

      {result && (
        <div className="mt-3 rounded-md border border-line bg-black/[0.02] px-3 py-2.5 text-xs">
          <p className="font-medium text-ink">
            {result.status === "SUCCESS" ? "Run complete." : "Run failed."}
          </p>
          <ul className="mt-1.5 flex flex-wrap gap-x-5 gap-y-1 text-ink-muted">
            <li>{result.engagementsScanned} engagements scanned</li>
            <li>{result.engagementsAdvanced} advanced</li>
            <li>{result.periodsCreated} periods opened</li>
            <li>{result.activitiesCreated} tasks generated</li>
            {result.assignmentsClosed > 0 && <li>{result.assignmentsClosed} closed</li>}
          </ul>
          {result.notes.length > 0 && (
            <ul className="mt-2 flex flex-col gap-0.5 text-ink-muted">
              {result.notes.map((n, i) => (
                <li key={i}>· {n}</li>
              ))}
            </ul>
          )}
          {result.skipped.length > 0 && (
            <p className="mt-2 text-ink-muted">
              Skipped —{" "}
              {result.skipped.map((s) => `${s.count} (${s.reason})`).join(", ")}
            </p>
          )}
          {result.error && <p className="mt-2 text-overdue">{result.error}</p>}
        </div>
      )}
    </div>
  );
}
