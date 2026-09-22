"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { submitRequestUpload, submitRequestDecision } from "@/lib/client-request-actions";
import { checkUpload } from "@/lib/client-requests";
import { formatBytes } from "@/lib/dates";

// The form on the client-facing page. Two shapes behind one component, because
// they share all the plumbing (the token, the name field, the error surface)
// and differ only in what they submit.
//
// This is written for somebody who does not use this app, has no account, and
// will do this once a month at most. So: no jargon, every error says what to
// do next, the file is validated in the browser BEFORE the upload starts (the
// server re-checks — the browser check exists to avoid a client watching a
// 20 MB upload crawl to a refusal), and the success state is unmistakable.

const inputClass =
  "w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40 disabled:opacity-50";

export function ClientRequestForm({
  token,
  kind,
  accept,
  maxBytes,
  alreadySent,
}: {
  token: string;
  kind: "UPLOAD" | "APPROVAL";
  accept: string;
  maxBytes: number;
  alreadySent: number;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  // Only set for "request changes", which needs the note to be filled in.
  const [decision, setDecision] = useState<null | "approve" | "changes">(null);

  function handleUpload() {
    const chosen = fileRef.current?.files?.[0] ?? null;
    if (!chosen) {
      setError("Choose a file first.");
      return;
    }
    // The same rules the server applies, run here so a client isn't left
    // watching a large upload fail at the end.
    const verdict = checkUpload({ name: chosen.name, size: chosen.size });
    if (!verdict.ok) {
      setError(verdict.reason);
      return;
    }

    setError(null);
    const form = new FormData();
    form.set("token", token);
    form.set("file", chosen);
    form.set("name", name);
    form.set("note", note);

    startTransition(async () => {
      try {
        const result = await submitRequestUpload(form);
        setDone(`Thank you — we've received ${result.filename}.`);
        setFile(null);
        setNote("");
        if (fileRef.current) fileRef.current.value = "";
        router.refresh();
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "That didn't send. Please try again."
        );
      }
    });
  }

  function handleDecision(approved: boolean) {
    if (!approved && !note.trim()) {
      setDecision("changes");
      setError("Please tell us what needs changing.");
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        await submitRequestDecision({ token, approved, name, note });
        setDone(
          approved
            ? "Thank you — we've recorded your approval."
            : "Thank you — we've passed your comments on."
        );
        router.refresh();
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "That didn't send. Please try again."
        );
      }
    });
  }

  if (done) {
    return (
      <div className="rounded-md border border-[var(--status-done)]/30 bg-[var(--status-done-soft)] px-4 py-3">
        <p className="text-sm font-medium text-[var(--status-done)]">{done}</p>
        {kind === "UPLOAD" && (
          <button
            type="button"
            onClick={() => setDone(null)}
            className="mt-2 text-xs text-[var(--status-done)] underline"
          >
            Send another file
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-ink-muted">Your name</span>
        <input
          value={name}
          disabled={isPending}
          onChange={(e) => setName(e.target.value)}
          placeholder="So we know who sent this"
          className={inputClass}
        />
      </label>

      {kind === "UPLOAD" ? (
        <>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-ink-muted">
              {alreadySent > 0 ? "Another file" : "Your file"}
            </span>
            <input
              ref={fileRef}
              type="file"
              accept={accept}
              disabled={isPending}
              onChange={(e) => {
                setError(null);
                setFile(e.target.files?.[0] ?? null);
              }}
              className="w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink file:mr-3 file:rounded-full file:border-0 file:bg-accent file:px-3 file:py-1 file:text-xs file:font-medium file:text-white disabled:opacity-50"
            />
            <span className="text-[11px] text-ink-muted">
              PDFs, images, documents and spreadsheets, up to{" "}
              {Math.floor(maxBytes / (1024 * 1024))} MB each.
              {file && ` Selected: ${file.name} (${formatBytes(file.size)}).`}
            </span>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-ink-muted">
              Anything we should know? (optional)
            </span>
            <textarea
              value={note}
              rows={2}
              disabled={isPending}
              onChange={(e) => setNote(e.target.value)}
              className={inputClass}
            />
          </label>

          <button
            type="button"
            onClick={handleUpload}
            disabled={isPending}
            className="rounded-full bg-accent px-4 py-2.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {isPending ? "Sending…" : "Send this file"}
          </button>
        </>
      ) : (
        <>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-ink-muted">
              {decision === "changes"
                ? "What needs changing?"
                : "Any comments? (optional)"}
            </span>
            <textarea
              value={note}
              rows={3}
              disabled={isPending}
              onChange={(e) => setNote(e.target.value)}
              placeholder={
                decision === "changes"
                  ? "Tell us what to look at again"
                  : "Anything you'd like us to note"
              }
              className={inputClass}
            />
          </label>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => handleDecision(true)}
              disabled={isPending}
              className="flex-1 rounded-full bg-[var(--status-done)] px-4 py-2.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {isPending ? "Sending…" : "Approve"}
            </button>
            <button
              type="button"
              onClick={() => handleDecision(false)}
              disabled={isPending}
              className="flex-1 rounded-full border border-line bg-surface px-4 py-2.5 text-sm font-medium text-ink hover:bg-black/5 disabled:opacity-50"
            >
              Request changes
            </button>
          </div>
        </>
      )}

      {error && (
        <p className="rounded-md border border-overdue/30 bg-overdue-soft/40 px-3 py-2 text-xs text-overdue">
          {error}
        </p>
      )}
    </div>
  );
}
