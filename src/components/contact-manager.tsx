"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createContact, updateContact, deleteContact, type ContactInput } from "@/lib/actions";

export type Contact = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  mobile: string | null;
  email: string | null;
  note: string | null;
};

const inputClass =
  "w-full rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40";

const EMPTY: ContactInput = { firstName: "", lastName: "", mobile: "", email: "", note: "" };

function initials(c: Contact): string {
  const a = c.firstName?.[0] ?? "";
  const b = c.lastName?.[0] ?? "";
  return (a + b).toUpperCase() || (c.email?.[0] ?? "?").toUpperCase();
}

function ContactFields({
  value,
  onChange,
  disabled,
}: {
  value: ContactInput;
  onChange: (next: ContactInput) => void;
  disabled: boolean;
}) {
  const set = (k: keyof ContactInput) => (e: React.ChangeEvent<HTMLInputElement>) =>
    onChange({ ...value, [k]: e.target.value });
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      <input value={value.firstName ?? ""} onChange={set("firstName")} disabled={disabled} placeholder="First name" className={inputClass} autoFocus />
      <input value={value.lastName ?? ""} onChange={set("lastName")} disabled={disabled} placeholder="Last name" className={inputClass} />
      <input value={value.mobile ?? ""} onChange={set("mobile")} disabled={disabled} placeholder="Mobile" className={inputClass} />
      <input value={value.email ?? ""} onChange={set("email")} disabled={disabled} placeholder="Email" type="email" className={inputClass} />
      <input value={value.note ?? ""} onChange={set("note")} disabled={disabled} placeholder="Note (role, best time to reach…)" className={`sm:col-span-2 ${inputClass}`} />
    </div>
  );
}

function ContactRow({ contact }: { contact: Contact }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<ContactInput>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function beginEdit() {
    setDraft({
      firstName: contact.firstName ?? "",
      lastName: contact.lastName ?? "",
      mobile: contact.mobile ?? "",
      email: contact.email ?? "",
      note: contact.note ?? "",
    });
    setError(null);
    setEditing(true);
  }

  function save() {
    setError(null);
    startTransition(async () => {
      try {
        await updateContact(contact.id, draft);
        setEditing(false);
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't save contact.");
      }
    });
  }

  function remove() {
    const name = [contact.firstName, contact.lastName].filter(Boolean).join(" ") || "this contact";
    if (!window.confirm(`Remove ${name}?`)) return;
    setError(null);
    startTransition(async () => {
      try {
        await deleteContact(contact.id);
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't remove contact.");
      }
    });
  }

  if (editing) {
    return (
      <li className="rounded-md border border-accent/40 bg-accent-soft/40 p-3">
        <ContactFields value={draft} onChange={setDraft} disabled={isPending} />
        <div className="mt-2 flex items-center gap-3">
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
            onClick={() => setEditing(false)}
            disabled={isPending}
            className="text-xs text-ink-muted hover:text-ink"
          >
            Cancel
          </button>
          {error && <span className="text-xs text-overdue">{error}</span>}
        </div>
      </li>
    );
  }

  const name = [contact.firstName, contact.lastName].filter(Boolean).join(" ");
  return (
    <li className="group flex items-start gap-3 rounded-md px-2 py-2.5 hover:bg-black/[0.02]">
      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-medium text-accent">
        {initials(contact)}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-ink">{name || "—"}</p>
        <p className="truncate text-xs text-ink-muted">
          {[contact.email, contact.mobile].filter(Boolean).join(" · ") || "No email or mobile"}
        </p>
        {contact.note && <p className="mt-0.5 text-xs text-ink-muted">{contact.note}</p>}
        {error && <p className="mt-1 text-xs text-overdue">{error}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-3 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        <button type="button" onClick={beginEdit} className="text-xs text-accent hover:underline">
          Edit
        </button>
        <button
          type="button"
          onClick={remove}
          disabled={isPending}
          className="text-xs text-ink-muted hover:text-overdue disabled:opacity-50"
        >
          Remove
        </button>
      </div>
    </li>
  );
}

// Contacts card on the client detail page: list, inline edit, remove, and an
// add form that stays collapsed until asked for.
export function ContactManager({ clientId, contacts }: { clientId: string; contacts: Contact[] }) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<ContactInput>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function add() {
    setError(null);
    startTransition(async () => {
      try {
        await createContact(clientId, draft);
        setDraft(EMPTY);
        setAdding(false);
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't add contact.");
      }
    });
  }

  return (
    <div className="rounded-lg border border-line bg-surface p-6">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-muted">
          Contacts
          {contacts.length > 0 && (
            <span className="tabular ml-2 rounded-full bg-black/5 px-1.5 py-0.5 text-[11px] normal-case tracking-normal">
              {contacts.length}
            </span>
          )}
        </h2>
        {!adding && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="rounded-full border border-line px-3 py-1 text-xs font-medium text-ink hover:bg-black/5"
          >
            + Add contact
          </button>
        )}
      </div>

      <ul className="flex flex-col">
        {contacts.map((c) => (
          <ContactRow key={c.id} contact={c} />
        ))}
        {contacts.length === 0 && !adding && (
          <li className="rounded-md border border-dashed border-line px-3 py-6 text-center text-sm text-ink-muted">
            No contacts on file.
          </li>
        )}
      </ul>

      {adding && (
        <div className="mt-3 rounded-md border border-accent/40 bg-accent-soft/40 p-3">
          <ContactFields value={draft} onChange={setDraft} disabled={isPending} />
          <div className="mt-2 flex items-center gap-3">
            <button
              type="button"
              onClick={add}
              disabled={isPending}
              className="rounded-full bg-accent px-3 py-1 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {isPending ? "Adding…" : "Add contact"}
            </button>
            <button
              type="button"
              onClick={() => {
                setAdding(false);
                setDraft(EMPTY);
                setError(null);
              }}
              disabled={isPending}
              className="text-xs text-ink-muted hover:text-ink"
            >
              Cancel
            </button>
            {error && <span className="text-xs text-overdue">{error}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
