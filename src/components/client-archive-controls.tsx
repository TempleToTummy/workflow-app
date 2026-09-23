"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { archiveClient, restoreClient, deleteClient } from "@/lib/actions";

const buttonClass =
  "rounded-full border border-line px-3 py-1 text-xs font-medium text-ink hover:bg-black/5 disabled:opacity-50";

// The "Archive client" button in a client page's header. Archiving is a soft
// delete (see archiveClient in src/lib/actions.ts), so the confirmation says
// exactly what happens and that it can be undone.
export function ArchiveClientButton({
  clientId,
  clientName,
}: {
  clientId: string;
  clientName: string;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleClick() {
    const ok = window.confirm(
      `Archive ${clientName}?\n\n` +
        "• It disappears from the dashboard, tasks, reports and search.\n" +
        "• No new periods are generated for it.\n" +
        "• Any open client-request links stop working.\n\n" +
        "Nothing is deleted — history, files and time stay, and you can restore it at any time."
    );
    if (!ok) return;
    setError(null);
    startTransition(async () => {
      try {
        await archiveClient(clientId);
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't archive the client.");
      }
    });
  }

  return (
    <span className="inline-flex flex-col items-end gap-1">
      <button type="button" onClick={handleClick} disabled={isPending} className={buttonClass}>
        {isPending ? "Archiving…" : "Archive client"}
      </button>
      {error && <span className="text-xs text-overdue">{error}</span>}
    </span>
  );
}

// Shown across the top of an archived client's page.
export function ArchivedClientBanner({
  clientId,
  clientName,
  archivedAt,
  archivedBy,
  canManage,
  historySummary,
}: {
  clientId: string;
  clientName: string;
  archivedAt: string;
  archivedBy: string | null;
  canManage: boolean;
  // e.g. "12 tasks, 3 files" — non-null means permanent deletion is refused,
  // and the button says why up front instead of failing on click.
  historySummary: string | null;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleRestore() {
    setError(null);
    startTransition(async () => {
      try {
        const { resumed } = await restoreClient(clientId);
        setMessage(
          resumed > 0
            ? `Restored. ${resumed} service${resumed === 1 ? "" : "s"} resumed from the current period.`
            : "Restored."
        );
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't restore the client.");
      }
    });
  }

  function handleDelete() {
    const typed = window.prompt(
      `Permanently delete ${clientName}? This can't be undone.\n\nType the client's name to confirm:`
    );
    if (typed === null) return;
    if (typed.trim() !== clientName.trim()) {
      setError("The name didn't match, so nothing was deleted.");
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        await deleteClient(clientId);
        router.push("/clients?archived=1");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't delete the client.");
      }
    });
  }

  return (
    <div className="mt-4 rounded-lg border border-[var(--status-review)]/40 bg-[var(--status-review)]/10 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm text-ink">
          <span className="font-medium">Archived</span>{" "}
          <span className="text-ink-muted">
            on {new Date(archivedAt).toLocaleDateString()}
            {archivedBy ? ` by ${archivedBy}` : ""}. Hidden from working views; no new periods
            are generated.
          </span>
        </div>
        {canManage && (
          <div className="flex items-center gap-2">
            <button type="button" onClick={handleRestore} disabled={isPending} className={buttonClass}>
              {isPending ? "Working…" : "Restore client"}
            </button>
            <button
              type="button"
              onClick={handleDelete}
              disabled={isPending || historySummary !== null}
              title={
                historySummary
                  ? `Has history on file (${historySummary}), so it can only be archived.`
                  : "Remove this client and its contacts for good."
              }
              className="rounded-full border border-line px-3 py-1 text-xs font-medium text-ink hover:border-overdue hover:text-overdue disabled:cursor-not-allowed disabled:opacity-40"
            >
              Delete permanently
            </button>
          </div>
        )}
      </div>
      {canManage && historySummary && (
        <p className="mt-1 text-xs text-ink-muted">
          Permanent deletion is unavailable: this client has {historySummary} on file.
        </p>
      )}
      {message && <p className="mt-1 text-xs text-accent">{message}</p>}
      {error && <p className="mt-1 text-xs text-overdue">{error}</p>}
    </div>
  );
}
