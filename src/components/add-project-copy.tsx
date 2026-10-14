"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { addProjectCopy } from "@/lib/actions";

// "Add another" on a client's project row: a second, completely independent
// copy of the same project for this client ("Bookkeeping 2", or any name),
// with its own checklist, periods, owner, notes and files.
export function AddProjectCopy({
  clientId,
  projectId,
  projectName,
  nextNumber,
}: {
  clientId: string;
  projectId: string;
  projectName: string;
  nextNumber: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const placeholder = `${projectName} ${nextNumber}`;

  function add() {
    setError(null);
    startTransition(async () => {
      try {
        const result = await addProjectCopy(clientId, projectId, name);
        setOpen(false);
        setName("");
        router.push(result.href);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't add it.");
      }
    });
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={`Run a second, separate ${projectName} for this client`}
        className="text-xs text-ink-muted hover:text-accent"
      >
        + Add another
      </button>
    );
  }

  return (
    <span className="inline-flex flex-wrap items-center justify-end gap-2">
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            add();
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
        placeholder={placeholder}
        maxLength={120}
        disabled={isPending}
        aria-label="Name for the new copy"
        className="w-56 rounded-md border border-line bg-surface px-2 py-1 text-xs text-ink focus:outline-none focus:ring-2 focus:ring-accent/40"
      />
      <button
        type="button"
        onClick={add}
        disabled={isPending}
        className="rounded-full bg-accent px-3 py-1 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
      >
        {isPending ? "Adding…" : "Add"}
      </button>
      <button type="button" onClick={() => setOpen(false)} className="text-xs text-ink-muted hover:text-ink">
        Cancel
      </button>
      {error && <span className="w-full text-right text-[11px] text-overdue">{error}</span>}
    </span>
  );
}
