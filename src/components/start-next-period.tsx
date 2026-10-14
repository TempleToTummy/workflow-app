"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { startNextPeriod } from "@/lib/actions";
import { formatPeriodName } from "@/lib/period-names";
import { engagementHref } from "@/lib/engagements";

// "Start next period now": opens the next period early so its work can begin
// while this one is still being finished. Both stay open until each is done.
// Once open it's just the next period — the same as if it had opened on
// schedule. Shown as a button by the page title and as the last chip in the
// Periods row ("chip").
export function StartNextPeriod({
  clientId,
  projectId,
  instance = 1,
  nextPeriod,
  currentDone,
  variant = "button",
}: {
  clientId: string;
  projectId: string;
  // Which copy of the project for this client (src/lib/engagements.ts).
  instance?: number;
  nextPeriod: string;
  currentDone: boolean;
  variant?: "button" | "chip";
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const label = formatPeriodName(nextPeriod);

  function start() {
    if (
      !currentDone &&
      !window.confirm(
        `Open ${label} early? Unfinished periods stay open too — each stays on the dashboard and Tasks list until it's finished.`
      )
    ) {
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        await startNextPeriod(clientId, projectId, instance);
        // The new period is now the engagement's current one.
        router.push(engagementHref({ clientId, projectId, instance }));
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't start the next period.");
      }
    });
  }

  if (variant === "chip") {
    return (
      <span className="inline-flex items-center gap-2">
        <button
          type="button"
          onClick={start}
          disabled={isPending}
          title={`${label} hasn't opened yet. Open it now to start its work early.`}
          className="tabular rounded-full border border-dashed border-accent/60 px-2.5 py-0.5 text-xs text-accent hover:bg-accent-soft disabled:opacity-50"
        >
          {isPending ? `Opening ${label}…` : `+ ${label}`}
          {!isPending && <span className="font-sans opacity-80"> · next, open early</span>}
        </button>
        {error && <span className="text-[11px] text-overdue">{error}</span>}
      </span>
    );
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
        {isPending ? "Opening…" : `Open ${label} early`}
      </button>
      {error && <span className="text-[11px] text-overdue">{error}</span>}
    </span>
  );
}
