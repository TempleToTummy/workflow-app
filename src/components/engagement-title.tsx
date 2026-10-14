"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { renameEngagement } from "@/lib/actions";

// The engagement's name as the page heading, renameable in place. A client can
// run the same project more than once ("Bookkeeping" and "Bookkeeping 2"), and
// each copy can be called whatever makes sense ("Bookkeeping — Holding LLC").
export function EngagementTitle({
  clientId,
  projectId,
  instance,
  label,
  customName,
  projectName,
}: {
  clientId: string;
  projectId: string;
  instance: number;
  label: string;
  customName: string;
  projectName: string;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(customName);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function save() {
    setError(null);
    startTransition(async () => {
      try {
        await renameEngagement(clientId, projectId, instance, value);
        setEditing(false);
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't rename.");
      }
    });
  }

  if (editing) {
    return (
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                save();
              } else if (e.key === "Escape") {
                setEditing(false);
                setValue(customName);
              }
            }}
            placeholder={instance > 1 ? `${projectName} ${instance}` : projectName}
            maxLength={120}
            disabled={isPending}
            className="min-w-64 rounded-md border border-line bg-surface px-3 py-1.5 text-xl font-semibold text-ink focus:outline-none focus:ring-2 focus:ring-accent/40"
          />
          <button
            type="button"
            onClick={save}
            disabled={isPending}
            className="rounded-full bg-accent px-3 py-1 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {isPending ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            onClick={() => {
              setEditing(false);
              setValue(customName);
            }}
            className="text-xs text-ink-muted hover:text-ink"
          >
            Cancel
          </button>
        </div>
        <p className="mt-1 text-xs text-ink-muted">Leave blank to use the project&apos;s name.</p>
        {error && <p className="mt-1 text-xs text-overdue">{error}</p>}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-baseline gap-2">
      <h1 className="text-2xl font-semibold tracking-tight">{label}</h1>
      {label !== projectName && <span className="text-sm text-ink-muted">{projectName}</span>}
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="text-xs font-medium text-accent hover:underline"
      >
        Rename
      </button>
    </div>
  );
}
