"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  createEmailTemplate,
  updateEmailTemplate,
  deleteEmailTemplate,
} from "@/lib/email-actions";
import { TEMPLATE_VARIABLES, templateVariables } from "@/lib/email";

export type ManagedTemplate = {
  id: string;
  key: string;
  name: string;
  description: string | null;
  subject: string;
  body: string;
  builtIn: boolean;
  usageCount: number;
};

const inputClass =
  "w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40";

const KNOWN = new Set(TEMPLATE_VARIABLES.map((v) => v.key));

// Template CRUD. Admin-only (the server actions enforce it too); everyone else
// reads the list on this page but doesn't get the editor.
export function EmailTemplateManager({
  templates,
  canEdit,
}: {
  templates: ManagedTemplate[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleDelete(template: ManagedTemplate) {
    if (
      !window.confirm(
        template.usageCount > 0
          ? `"${template.name}" has been used on ${template.usageCount} message${
              template.usageCount === 1 ? "" : "s"
            }. Those messages keep their content; only the template is removed. Continue?`
          : `Delete the "${template.name}" template?`
      )
    ) {
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        await deleteEmailTemplate(template.id);
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't delete that template.");
      }
    });
  }

  return (
    <div className="flex flex-col gap-4">
      {error && <p className="text-sm text-overdue">{error}</p>}

      {canEdit && !creating && (
        <button
          type="button"
          onClick={() => {
            setCreating(true);
            setEditing(null);
          }}
          className="self-start whitespace-nowrap rounded-full bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90"
        >
          + New template
        </button>
      )}

      {creating && (
        <TemplateForm
          onCancel={() => setCreating(false)}
          onSave={async (values) => {
            await createEmailTemplate(values);
            setCreating(false);
            router.refresh();
          }}
        />
      )}

      <ul className="flex flex-col gap-3">
        {templates.map((t) =>
          editing === t.id ? (
            <li key={t.id}>
              <TemplateForm
                template={t}
                onCancel={() => setEditing(null)}
                onSave={async (values) => {
                  await updateEmailTemplate(t.id, values);
                  setEditing(null);
                  router.refresh();
                }}
              />
            </li>
          ) : (
            <li key={t.id} className="rounded-lg border border-line bg-surface p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-sm font-medium text-ink">
                    {t.name}
                    {t.builtIn && (
                      <span
                        title="Shipped with the app. Editing it is fine; it just started here."
                        className="rounded-full bg-black/5 px-1.5 py-0.5 text-[10px] font-medium text-ink-muted"
                      >
                        built in
                      </span>
                    )}
                  </p>
                  {t.description && (
                    <p className="text-xs text-ink-muted">{t.description}</p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-3 text-xs">
                  <span className="text-ink-muted">
                    {t.usageCount} {t.usageCount === 1 ? "use" : "uses"}
                  </span>
                  {canEdit && (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          setEditing(t.id);
                          setCreating(false);
                        }}
                        className="text-accent hover:underline"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(t)}
                        disabled={isPending}
                        className="text-ink-muted hover:text-overdue disabled:opacity-50"
                      >
                        Delete
                      </button>
                    </>
                  )}
                </div>
              </div>

              <p className="mt-3 text-xs font-medium text-ink">{t.subject}</p>
              <p className="mt-1 line-clamp-4 whitespace-pre-wrap text-xs text-ink-muted">
                {t.body}
              </p>
              <Placeholders source={`${t.subject}\n${t.body}`} />
            </li>
          )
        )}
        {templates.length === 0 && (
          <li className="rounded-lg border border-dashed border-line px-4 py-10 text-center text-sm text-ink-muted">
            No templates yet.
          </li>
        )}
      </ul>
    </div>
  );
}

// Shows which placeholders a template uses, and flags any that won't resolve —
// a typo like {{client}} instead of {{client_name}} renders as an empty string
// in a message a client reads, so it's worth catching here.
function Placeholders({ source }: { source: string }) {
  const used = templateVariables(source);
  if (used.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1">
      {used.map((v) => {
        const known = KNOWN.has(v);
        return (
          <span
            key={v}
            title={known ? undefined : "Not a known placeholder — this will render as empty."}
            className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${
              known ? "bg-black/5 text-ink-muted" : "bg-overdue/10 text-overdue"
            }`}
          >
            {`{{${v}}}`}
            {!known && " ?"}
          </span>
        );
      })}
    </div>
  );
}

function TemplateForm({
  template,
  onSave,
  onCancel,
}: {
  template?: ManagedTemplate;
  onSave: (values: {
    name: string;
    subject: string;
    body: string;
    description: string | null;
  }) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(template?.name ?? "");
  const [description, setDescription] = useState(template?.description ?? "");
  const [subject, setSubject] = useState(template?.subject ?? "");
  const [body, setBody] = useState(template?.body ?? "");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleSave() {
    setError(null);
    startTransition(async () => {
      try {
        await onSave({
          name,
          subject,
          body,
          description: description.trim() || null,
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't save the template.");
      }
    });
  }

  function insert(variable: string) {
    setBody((current) => `${current}{{${variable}}}`);
  }

  return (
    <div className="rounded-lg border border-accent/30 bg-surface p-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs text-ink-muted">Name</span>
          <input
            value={name}
            disabled={isPending}
            onChange={(e) => setName(e.target.value)}
            placeholder="Request documents"
            className={inputClass}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs text-ink-muted">Description — shown in the picker</span>
          <input
            value={description}
            disabled={isPending}
            onChange={(e) => setDescription(e.target.value)}
            className={inputClass}
          />
        </label>
      </div>

      <label className="mt-3 flex flex-col gap-1 text-sm">
        <span className="text-xs text-ink-muted">Subject</span>
        <input
          value={subject}
          disabled={isPending}
          onChange={(e) => setSubject(e.target.value)}
          className={inputClass}
        />
      </label>

      <label className="mt-3 flex flex-col gap-1 text-sm">
        <span className="text-xs text-ink-muted">Body</span>
        <textarea
          value={body}
          rows={10}
          disabled={isPending}
          onChange={(e) => setBody(e.target.value)}
          className={`${inputClass} resize-y leading-relaxed`}
        />
      </label>

      <div className="mt-2">
        <p className="text-[11px] text-ink-muted">Click to insert:</p>
        <div className="mt-1 flex flex-wrap gap-1">
          {TEMPLATE_VARIABLES.map((v) => (
            <button
              key={v.key}
              type="button"
              title={v.description}
              disabled={isPending}
              onClick={() => insert(v.key)}
              className="rounded border border-line px-1.5 py-0.5 font-mono text-[10px] text-ink-muted hover:border-accent/40 hover:text-accent disabled:opacity-50"
            >
              {`{{${v.key}}}`}
            </button>
          ))}
        </div>
      </div>

      <Placeholders source={`${subject}\n${body}`} />

      {error && <p className="mt-2 text-sm text-overdue">{error}</p>}

      <div className="mt-4 flex gap-2">
        <button
          type="button"
          onClick={handleSave}
          disabled={isPending || !name.trim() || !subject.trim() || !body.trim()}
          className="whitespace-nowrap rounded-full bg-accent px-4 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-40"
        >
          {isPending ? "Saving…" : "Save template"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={isPending}
          className="rounded-full border border-line px-4 py-1.5 text-sm font-medium text-ink hover:bg-black/5"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
