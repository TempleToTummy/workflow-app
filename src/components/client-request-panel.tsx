"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  createClientRequest,
  resendClientRequest,
  revokeClientRequest,
} from "@/lib/client-request-actions";
import { defaultTitle, REQUEST_TTL_LABEL } from "@/lib/client-requests";
import { formatDate } from "@/lib/dates";

export type RequestRow = {
  id: string;
  kind: "UPLOAD" | "APPROVAL";
  title: string;
  stepName: string | null;
  stateLabel: string;
  stateTone: "waiting" | "good" | "warn" | "bad";
  expiresAt: string;
  viewCount: number;
  lastViewedAt: string | null;
  documentCount: number;
  respondedByName: string | null;
  responseNote: string | null;
  createdByLabel: string;
};

export type RequestStep = { id: string; name: string; suggestedKind: "UPLOAD" | "APPROVAL" | null };

const TONE_CLASS: Record<RequestRow["stateTone"], string> = {
  waiting: "bg-[var(--status-review-soft)] text-[var(--status-review)]",
  good: "bg-[var(--status-done-soft)] text-[var(--status-done)]",
  warn: "bg-[var(--status-review-soft)] text-[var(--status-review)]",
  bad: "bg-overdue-soft text-overdue",
};

const inputClass =
  "w-full rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40 disabled:opacity-50";

// The staff side of client requests: raise one, see what's outstanding, revoke
// or re-issue a link.
//
// The link is ALWAYS shown for copying, whether or not the email went. With no
// mail provider configured the app records messages without delivering them
// (see src/lib/email.ts), and telling someone their client had been emailed
// when nothing left the building would be worse than the missing feature —
// this mirrors the invite and password-reset flows, which do the same.
export function ClientRequestPanel({
  clientId,
  projectId,
  periodName,
  steps,
  requests,
  contactEmail,
}: {
  clientId: string;
  projectId: string;
  periodName: string | null;
  steps: RequestStep[];
  requests: RequestRow[];
  contactEmail: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [activityId, setActivityId] = useState("");
  const [kind, setKind] = useState<"UPLOAD" | "APPROVAL">("UPLOAD");
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [sendEmail, setSendEmail] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<{ url: string; emailed: string | null } | null>(null);
  const [isPending, startTransition] = useTransition();

  // Picking a step fills in the ask. "Document Received" and "Review done by
  // Client" are real steps in the firm's checklist, so the suggestion lands on
  // a seeded engagement with no configuration at all (see
  // suggestedKindForStep in src/lib/client-requests.ts).
  function chooseStep(id: string) {
    setActivityId(id);
    const step = steps.find((s) => s.id === id);
    if (!step) return;
    const nextKind = step.suggestedKind ?? kind;
    setKind(nextKind);
    setTitle(defaultTitle(nextKind, step.name, periodName));
  }

  function submit() {
    if (!title.trim()) {
      setError("Say what you're asking the client for.");
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        const result = await createClientRequest({
          clientId,
          projectId,
          periodName,
          activityId: activityId || null,
          kind,
          title: title.trim(),
          message: message.trim() || null,
          email: sendEmail,
        });
        setIssued({
          url: result.url,
          emailed: result.emailed
            ? result.emailed.delivered
              ? `Emailed to ${result.emailed.to}.`
              : `Recorded for ${result.emailed.to}, but no mail provider is configured — send the link yourself.`
            : sendEmail
              ? "No contact email on file for this client — send the link yourself."
              : null,
        });
        setTitle("");
        setMessage("");
        setActivityId("");
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't raise that request.");
      }
    });
  }

  return (
    <div className="no-print rounded-lg border border-line bg-surface p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold tracking-wide text-ink-muted uppercase">
          Client requests
        </h2>
        <button
          type="button"
          onClick={() => {
            setOpen((v) => !v);
            setIssued(null);
          }}
          className="rounded-full border border-line px-2.5 py-1 text-xs font-medium text-ink hover:bg-black/5"
        >
          {open ? "Cancel" : "Ask client"}
        </button>
      </div>

      <p className="mt-1.5 text-[11px] text-ink-muted">
        A one-off link that lets the client send a document or approve a report. No
        account, no password; it expires after {REQUEST_TTL_LABEL}.
      </p>

      {open && (
        <div className="mt-3 flex flex-col gap-2 border-t border-line pt-3">
          <select
            value={activityId}
            disabled={isPending}
            onChange={(e) => chooseStep(e.target.value)}
            className={inputClass}
          >
            <option value="">Which step is blocked? (optional)</option>
            {steps.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {s.suggestedKind ? " ←" : ""}
              </option>
            ))}
          </select>

          <div className="flex gap-1.5">
            {(["UPLOAD", "APPROVAL"] as const).map((k) => (
              <button
                key={k}
                type="button"
                disabled={isPending}
                onClick={() => setKind(k)}
                className={`flex-1 rounded-full border px-2 py-1 text-xs font-medium transition-colors ${
                  kind === k
                    ? "border-accent bg-accent-soft text-accent"
                    : "border-line text-ink-muted hover:text-ink"
                }`}
              >
                {k === "UPLOAD" ? "Send us a file" : "Approve something"}
              </button>
            ))}
          </div>

          <input
            value={title}
            disabled={isPending}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="What are you asking for?"
            className={inputClass}
          />
          <textarea
            value={message}
            rows={2}
            disabled={isPending}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Anything else they need to know (optional)"
            className={inputClass}
          />

          <label className="flex items-center gap-1.5 text-xs text-ink-muted">
            <input
              type="checkbox"
              checked={sendEmail}
              disabled={isPending}
              onChange={(e) => setSendEmail(e.target.checked)}
              className="h-3.5 w-3.5 accent-[var(--accent)]"
            />
            Email it to {contactEmail ?? "the client"}
            {!contactEmail && " (no address on file)"}
          </label>

          <button
            type="button"
            onClick={submit}
            disabled={isPending || !title.trim()}
            className="rounded-full bg-accent px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {isPending ? "Creating…" : "Create link"}
          </button>

          {error && <p className="text-[11px] text-overdue">{error}</p>}
        </div>
      )}

      {issued && <IssuedLink url={issued.url} emailed={issued.emailed} />}

      <ul className="mt-3 flex flex-col gap-2">
        {requests.map((r) => (
          <RequestItem key={r.id} request={r} />
        ))}
        {requests.length === 0 && !open && (
          <li className="text-[11px] text-ink-muted">Nothing asked of this client yet.</li>
        )}
      </ul>
    </div>
  );
}

// The raw token exists exactly once, in this response. It is never stored
// (only its SHA-256 hash is), so this is the one chance to copy it — which is
// why it is displayed prominently rather than tucked behind a tooltip.
function IssuedLink({ url, emailed }: { url: string; emailed: string | null }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-3 rounded-md border border-accent/30 bg-accent-soft px-3 py-2">
      <p className="text-[11px] font-medium text-accent">Link created</p>
      {emailed && <p className="mt-0.5 text-[11px] text-accent">{emailed}</p>}
      <div className="mt-1.5 flex items-center gap-1.5">
        <input
          readOnly
          value={url}
          onFocus={(e) => e.currentTarget.select()}
          className="tabular min-w-0 flex-1 rounded border border-accent/30 bg-surface px-2 py-1 text-[11px] text-ink"
        />
        <button
          type="button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(url);
              setCopied(true);
              window.setTimeout(() => setCopied(false), 2000);
            } catch {
              // Clipboard access can be refused (insecure origin, permissions).
              // The input is selectable, so this is a lost convenience, not a
              // lost link — saying so beats a button that silently does
              // nothing.
              setCopied(false);
            }
          }}
          className="shrink-0 rounded-full bg-accent px-2 py-1 text-[11px] font-medium text-white"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <p className="mt-1 text-[11px] text-accent/80">
        This is the only time the link is shown. Re-issue it later if it&apos;s lost.
      </p>
    </div>
  );
}

function RequestItem({ request }: { request: RequestRow }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [reissued, setReissued] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);

  return (
    <li className="rounded-md border border-line px-2.5 py-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-xs font-medium text-ink">{request.title}</p>
          <p className="text-[11px] text-ink-muted">
            {request.kind === "UPLOAD" ? "Document" : "Approval"}
            {request.stepName && ` · ${request.stepName}`}
            {" · "}
            {/* Opens answer "have they even looked at it" before somebody
                picks up the phone. */}
            {request.viewCount === 0
              ? "not opened"
              : `opened ${request.viewCount}×${
                  request.lastViewedAt ? ` · ${formatDate(request.lastViewedAt)}` : ""
                }`}
          </p>
        </div>
        <span
          className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${TONE_CLASS[request.stateTone]}`}
        >
          {request.stateLabel}
        </span>
      </div>

      {request.responseNote && (
        <p className="mt-1.5 rounded border border-line bg-black/[0.02] px-2 py-1 text-[11px] whitespace-pre-wrap text-ink">
          {request.respondedByName ? `${request.respondedByName}: ` : ""}
          {request.responseNote}
        </p>
      )}

      <div className="mt-1.5 flex items-center gap-2 text-[11px] text-ink-muted">
        <button
          type="button"
          disabled={isPending}
          onClick={() => {
            setError(null);
            startTransition(async () => {
              try {
                const result = await resendClientRequest(request.id, { email: true });
                setReissued(result.url);
                router.refresh();
              } catch (err) {
                setError(err instanceof Error ? err.message : "Couldn't re-issue the link.");
              }
            });
          }}
          className="hover:text-accent disabled:opacity-50"
        >
          Re-issue link
        </button>
        <button
          type="button"
          disabled={isPending}
          onClick={() => {
            if (!confirmRevoke) {
              setConfirmRevoke(true);
              return;
            }
            setError(null);
            startTransition(async () => {
              try {
                await revokeClientRequest(request.id);
                router.refresh();
              } catch (err) {
                setError(err instanceof Error ? err.message : "Couldn't revoke that.");
              }
            });
          }}
          onBlur={() => setConfirmRevoke(false)}
          className={confirmRevoke ? "font-medium text-overdue" : "hover:text-overdue"}
        >
          {confirmRevoke ? "Revoke?" : "Revoke"}
        </button>
        <span className="ml-auto">expires {formatDate(request.expiresAt)}</span>
      </div>

      {reissued && <IssuedLink url={reissued} emailed={null} />}
      {error && <p className="mt-1 text-[11px] text-overdue">{error}</p>}
    </li>
  );
}
