"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { EmailComposer, type ComposerClient, type ComposerTemplate } from "@/components/email-composer";
import { retryEmailMessage } from "@/lib/email-actions";

// The reply box under a thread. Collapsed to a single button until you want it,
// so a long conversation isn't pushed off screen by a textarea nobody's using.
//
// When the last outbound message in the thread failed, this also offers to
// retry it — resending the stored content keeps the message in the thread,
// where composing a fresh one would start a new conversation.
export function EmailThreadReply({
  clients,
  templates,
  live,
  clientId,
  projectId,
  periodName,
  threadKey,
  replyTo,
  subject,
  failedMessage,
}: {
  clients: ComposerClient[];
  templates: ComposerTemplate[];
  live: boolean;
  clientId: string | null;
  projectId: string | null;
  periodName: string | null;
  threadKey: string;
  replyTo: string;
  subject: string;
  failedMessage: { id: string; error: string | null } | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [retryError, setRetryError] = useState<string | null>(null);

  function handleRetry() {
    setRetryError(null);
    startTransition(async () => {
      try {
        const result = await retryEmailMessage(failedMessage!.id);
        if (result.status === "failed") {
          setRetryError(result.error ?? "The provider rejected it again.");
        }
        router.refresh();
      } catch (err) {
        setRetryError(err instanceof Error ? err.message : "Couldn't retry that message.");
      }
    });
  }

  return (
    <div className="flex flex-col gap-3">
      {failedMessage && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-overdue/30 bg-overdue/5 px-3 py-2">
          <p className="text-xs text-overdue">
            The last message in this thread didn&apos;t go out.
            {failedMessage.error ? ` ${failedMessage.error}` : ""}
          </p>
          <button
            type="button"
            onClick={handleRetry}
            disabled={isPending}
            className="shrink-0 rounded-full border border-overdue/40 px-3 py-1 text-xs font-medium text-overdue hover:bg-overdue/10 disabled:opacity-50"
          >
            {isPending ? "Retrying…" : "Retry send"}
          </button>
        </div>
      )}
      {retryError && <p className="text-xs text-overdue">{retryError}</p>}

      {open ? (
        <EmailComposer
          compact
          clients={clients}
          templates={templates}
          live={live}
          fixedClientId={clientId ?? undefined}
          fixedProjectId={projectId}
          fixedPeriodName={periodName}
          threadKey={threadKey}
          defaultTo={replyTo}
          defaultSubject={subject}
          onSent={() => setOpen(false)}
        />
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="w-full rounded-md border border-line px-4 py-2.5 text-left text-sm text-ink-muted hover:border-ink-muted/40 hover:text-ink"
        >
          Reply to {replyTo}…
        </button>
      )}
    </div>
  );
}
