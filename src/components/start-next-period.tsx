"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { startNextPeriod } from "@/lib/actions";
import { formatPeriodName } from "@/lib/period-names";

// "Start next period now": opens the next period early so its work can begin
// while this one is still being finished. Both stay open until each is done.
export function StartNextPeriod({
  clientId,
  projectId,
  nextPeriod,
  currentDone,
}: {
  clientId: string;
  projectId: string;
  nextPeriod: string;
  currentDone: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const label = formatPeriodName(nextPeriod);

  function start() {
    if (
      !currentDone &&
      !window.confirm(
        `Start ${label} now? This period stays open too — both will be on the dashboard and Tasks list until each is finished.`
      )
    ) {
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        await startNextPeriod(clientId, projectId);
        router.push(`/assignments/${clientId}/${projectId}`);
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't start the next period.");
      }
    });
  }

  return (
    <span className="inline-flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={start}
        disabled={isPending}
        title="Open the next period now, while this one is still being finished."
        className="whitespace-nowrap rounded-full border border-line px-3 py-1 text-xs font-medium text-ink hover:bg-black/5 disabled:opacity-50"
      >
        {isPending ? "Starting…" : `Start ${label} now`}
      </button>
      {error && <span className="text-[11px] text-overdue">{error}</span>}
    </span>
  );
}
