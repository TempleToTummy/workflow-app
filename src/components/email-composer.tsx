"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { sendEmailMessage, renderTemplateForEngagement } from "@/lib/email-actions";

// The compose surface, used both for a new message (/email/new) and for
// replying inside a thread (/email/[id]).
//
// Picking a client narrows the project list and the recipient list to that
// client's contacts, because in practice every message is about one
// engagement. Picking a template renders it on the server against that
// engagement's real data — open task count, next step, the resolved due date —
// so what you see in the box is exactly what goes out.

export type ComposerClient = {
  id: string;
  name: string;
  email: string | null;
  contacts: { id: string; name: string; email: string; firstName: string | null }[];
  projects: { id: string; name: string; currentPeriod: string | null }[];
};

export type ComposerTemplate = {
  key: string;
  name: string;
  description: string | null;
};

const inputClass =
  "w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40";

export function EmailComposer({
  clients,
  templates,
  live,
  fixedClientId,
  fixedProjectId,
  fixedPeriodName,
  threadKey,
  defaultTo,
  defaultSubject,
  compact = false,
  onSent,
}: {
  clients: ComposerClient[];
  templates: ComposerTemplate[];
  // Whether a real mail provider is configured. Drives the warning banner —
  // sending into a void without saying so would be the worst outcome here.
  live: boolean;
  fixedClientId?: string;
  fixedProjectId?: string | null;
  fixedPeriodName?: string | null;
  threadKey?: string;
  defaultTo?: string;
  defaultSubject?: string;
  // Reply mode: collapses the engagement pickers, since the thread fixes them.
  compact?: boolean;
  onSent?: () => void;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const [clientId, setClientId] = useState(fixedClientId ?? "");
  const [projectId, setProjectId] = useState(fixedProjectId ?? "");
  const [toEmail, setToEmail] = useState(defaultTo ?? "");
  const [cc, setCc] = useState("");
  const [showCc, setShowCc] = useState(false);
  const [subject, setSubject] = useState(defaultSubject ?? "");
  const [body, setBody] = useState("");
  const [templateKey, setTemplateKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const client = clients.find((c) => c.id === clientId) ?? null;
  const projects = client?.projects ?? [];
  const project = projects.find((p) => p.id === projectId) ?? null;
  const periodName = fixedPeriodName ?? project?.currentPeriod ?? null;

  // Every address we can offer for the chosen client: their contacts plus the
  // company address on the client record.
  const recipients = client
    ? [
        ...client.contacts.map((c) => ({ email: c.email, label: `${c.name} · ${c.email}` })),
        ...(client.email &&
        !client.contacts.some((c) => c.email.toLowerCase() === client.email!.toLowerCase())
          ? [{ email: client.email, label: `${client.name} · ${client.email}` }]
          : []),
      ]
    : [];

  const contactFirstName =
    client?.contacts.find((c) => c.email.toLowerCase() === toEmail.trim().toLowerCase())
      ?.firstName ?? null;

  function handleClient(next: string) {
    setClientId(next);
    setProjectId("");
    setError(null);
    // Auto-fill the recipient when the client has exactly one address on file.
    const picked = clients.find((c) => c.id === next);
    const only =
      picked && picked.contacts.length === 1 && !picked.email
        ? picked.contacts[0].email
        : picked && picked.contacts.length === 0 && picked.email
        ? picked.email
        : null;
    setToEmail(only ?? "");
  }

  function applyTemplate(key: string) {
    setTemplateKey(key);
    setError(null);
    if (!key) return;
    startTransition(async () => {
      try {
        const rendered = await renderTemplateForEngagement({
          templateKey: key,
          clientId: clientId || null,
          projectId: projectId || null,
          periodName,
          contactFirstName,
        });
        setSubject(rendered.subject);
        setBody(rendered.body);
        setNotice(
          clientId
            ? null
            : "Template applied. Pick a client to fill in the client-specific placeholders."
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't load that template.");
      }
    });
  }

  function handleSend() {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      try {
        const result = await sendEmailMessage({
          clientId: clientId || null,
          projectId: projectId || null,
          periodName,
          toEmail,
          cc: cc || null,
          subject,
          body,
          templateKey: templateKey || null,
          threadKey: threadKey ?? null,
        });

        if (result.status === "FAILED") {
          setError(result.error ?? "The mail provider rejected the message.");
          router.refresh();
          return;
        }

        setBody("");
        setSubject("");
        setTemplateKey("");
        setCc("");
        onSent?.();
        router.refresh();
        if (!compact) router.push(`/email/${result.id}`);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't send the message.");
      }
    });
  }

  const canSend = toEmail.trim() && subject.trim() && body.trim() && !isPending;

  return (
    <div className="flex flex-col gap-4">
      {!live && (
        <div className="rounded-lg border border-[var(--status-review)]/30 bg-[var(--status-review-soft)] px-4 py-3 text-xs text-[var(--status-review)]">
          <strong className="font-semibold">No mail provider is configured.</strong> Messages
          are composed and recorded here, but nothing is delivered. Set{" "}
          <code className="rounded bg-black/5 px-1">RESEND_API_KEY</code> to send for real.
        </div>
      )}

      {!compact && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-ink-muted">Client</span>
            <select
              value={clientId}
              disabled={isPending}
              onChange={(e) => handleClient(e.target.value)}
              className={inputClass}
            >
              <option value="">No client (general message)</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-ink-muted">
              Project {periodName && <span className="tabular">· {periodName}</span>}
            </span>
            <select
              value={projectId}
              disabled={isPending || !client || projects.length === 0}
              onChange={(e) => setProjectId(e.target.value)}
              className={inputClass}
            >
              <option value="">
                {client ? "No specific project" : "Pick a client first"}
              </option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="flex items-center justify-between text-xs text-ink-muted">
            <span>To</span>
            {!showCc && (
              <button
                type="button"
                onClick={() => setShowCc(true)}
                className="text-ink-muted hover:text-accent"
              >
                + Cc
              </button>
            )}
          </span>
          <input
            type="email"
            value={toEmail}
            disabled={isPending}
            list="composer-recipients"
            placeholder="name@company.com"
            onChange={(e) => setToEmail(e.target.value)}
            className={inputClass}
          />
          <datalist id="composer-recipients">
            {recipients.map((r) => (
              <option key={r.email} value={r.email}>
                {r.label}
              </option>
            ))}
          </datalist>
        </label>

        {recipients.length > 0 && (
          <div className="-mt-1 flex flex-wrap gap-1.5">
            {recipients.map((r) => (
              <button
                key={r.email}
                type="button"
                disabled={isPending}
                onClick={() => setToEmail(r.email)}
                className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors disabled:opacity-50 ${
                  toEmail.trim().toLowerCase() === r.email.toLowerCase()
                    ? "border-accent bg-accent-soft text-accent"
                    : "border-line text-ink-muted hover:border-ink-muted/40 hover:text-ink"
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
        )}

        {showCc && (
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-ink-muted">Cc — comma separated</span>
            <input
              value={cc}
              disabled={isPending}
              onChange={(e) => setCc(e.target.value)}
              className={inputClass}
            />
          </label>
        )}

        {templates.length > 0 && (
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-ink-muted">
              Template — fills the subject and body from this engagement&apos;s data
            </span>
            <select
              value={templateKey}
              disabled={isPending}
              onChange={(e) => applyTemplate(e.target.value)}
              className={inputClass}
            >
              <option value="">Start from a blank message</option>
              {templates.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.name}
                  {t.description ? ` — ${t.description}` : ""}
                </option>
              ))}
            </select>
          </label>
        )}

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs text-ink-muted">Subject</span>
          <input
            value={subject}
            disabled={isPending}
            onChange={(e) => setSubject(e.target.value)}
            className={inputClass}
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs text-ink-muted">Message</span>
          <textarea
            value={body}
            disabled={isPending}
            rows={compact ? 6 : 14}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Write your message…"
            className={`${inputClass} resize-y font-sans leading-relaxed`}
          />
        </label>
      </div>

      {error && <p className="text-sm text-overdue">{error}</p>}
      {notice && <p className="text-sm text-ink-muted">{notice}</p>}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={handleSend}
          disabled={!canSend}
          className="whitespace-nowrap rounded-full bg-accent px-5 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-40"
        >
          {isPending ? "Sending…" : live ? "Send" : "Record message"}
        </button>
        {!compact && (
          <button
            type="button"
            onClick={() => router.push("/email")}
            className="rounded-full border border-line px-5 py-2 text-sm font-medium text-ink hover:bg-black/5"
          >
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}
