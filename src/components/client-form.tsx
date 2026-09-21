"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  createClient,
  updateClient,
  assignProjectToClient,
  createContact,
  updateContact,
  deleteContact,
  type ClientFormInput,
  type ContactInput,
} from "@/lib/actions";

type Lookup = { id: string; name: string };

type ExistingClient = ClientFormInput & { id: string };

export type ExistingContact = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  mobile: string | null;
  email: string | null;
  note: string | null;
};

// A contact row being edited in the form. `id` is set for rows that already
// exist in the database; new rows get a client-side key only.
type DraftContact = {
  key: string;
  id?: string;
  firstName: string;
  lastName: string;
  mobile: string;
  email: string;
  note: string;
};

const RECURRING_LABELS: Record<string, string> = {
  MONTHLY: "Monthly",
  QUARTERLY: "Quarterly",
  ANNUAL: "Every Year",
  ONE_TIME: "One time only",
};

export type ServiceOption = {
  id: string;
  name: string;
  description: string | null;
  recurring: string;
  stepCount: number;
};

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-xs text-ink-muted">{label}</span>
      {children}
    </label>
  );
}

const inputClass =
  "rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40";

function newDraft(): DraftContact {
  return {
    key: crypto.randomUUID(),
    firstName: "",
    lastName: "",
    mobile: "",
    email: "",
    note: "",
  };
}

function fromExisting(c: ExistingContact): DraftContact {
  return {
    key: c.id,
    id: c.id,
    firstName: c.firstName ?? "",
    lastName: c.lastName ?? "",
    mobile: c.mobile ?? "",
    email: c.email ?? "",
    note: c.note ?? "",
  };
}

function isBlank(d: DraftContact): boolean {
  return !d.firstName.trim() && !d.lastName.trim() && !d.mobile.trim() && !d.email.trim();
}

function toInput(d: DraftContact): ContactInput {
  return {
    firstName: d.firstName,
    lastName: d.lastName,
    mobile: d.mobile,
    email: d.email,
    note: d.note,
  };
}

function sameContact(a: DraftContact, b: ExistingContact): boolean {
  return (
    a.firstName.trim() === (b.firstName ?? "") &&
    a.lastName.trim() === (b.lastName ?? "") &&
    a.mobile.trim() === (b.mobile ?? "") &&
    a.email.trim() === (b.email ?? "") &&
    a.note.trim() === (b.note ?? "")
  );
}

export function ClientForm({
  mode,
  client,
  contacts: existingContacts = [],
  corpTypes,
  businessTypes,
  services,
  assignedServiceIds = [],
}: {
  mode: "create" | "edit";
  client?: ExistingClient;
  contacts?: ExistingContact[];
  corpTypes: Lookup[];
  businessTypes: Lookup[];
  services: ServiceOption[];
  assignedServiceIds?: string[];
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [selectedServices, setSelectedServices] = useState<Set<string>>(
    new Set(assignedServiceIds)
  );
  const [contacts, setContacts] = useState<DraftContact[]>(() =>
    existingContacts.length > 0 ? existingContacts.map(fromExisting) : [newDraft()]
  );

  function toggleService(id: string) {
    setSelectedServices((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function updateContactDraft(key: string, patch: Partial<DraftContact>) {
    setContacts((prev) => prev.map((c) => (c.key === key ? { ...c, ...patch } : c)));
  }

  function removeContactDraft(key: string) {
    setContacts((prev) => prev.filter((c) => c.key !== key));
  }

  // Reconcile the contact drafts against what's already saved: create the new
  // ones, update the changed ones, delete the removed ones. Blank rows are
  // ignored so an untouched empty row never errors.
  async function syncContacts(clientId: string): Promise<string[]> {
    const failures: string[] = [];
    const existingById = new Map(existingContacts.map((c) => [c.id, c]));
    const keptIds = new Set(contacts.filter((c) => c.id).map((c) => c.id!));

    for (const draft of contacts) {
      const label =
        [draft.firstName, draft.lastName].filter((s) => s.trim()).join(" ").trim() ||
        draft.email ||
        draft.mobile ||
        "contact";
      try {
        if (draft.id) {
          const original = existingById.get(draft.id);
          if (original && !sameContact(draft, original)) {
            await updateContact(draft.id, toInput(draft));
          }
        } else if (!isBlank(draft)) {
          await createContact(clientId, toInput(draft));
        }
      } catch (err) {
        failures.push(`${label}: ${err instanceof Error ? err.message : "couldn't save"}`);
      }
    }
    for (const original of existingContacts) {
      if (keptIds.has(original.id)) continue;
      try {
        await deleteContact(original.id);
      } catch (err) {
        failures.push(
          `${original.firstName ?? ""} ${original.lastName ?? ""}: ${
            err instanceof Error ? err.message : "couldn't delete"
          }`.trim()
        );
      }
    }
    return failures;
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    const form = new FormData(e.currentTarget);
    const values: ClientFormInput = {
      companyName: String(form.get("companyName") ?? ""),
      groupName: String(form.get("groupName") ?? ""),
      corpTypeId: String(form.get("corpTypeId") ?? ""),
      businessTypeId: String(form.get("businessTypeId") ?? ""),
      address1: String(form.get("address1") ?? ""),
      address2: String(form.get("address2") ?? ""),
      city: String(form.get("city") ?? ""),
      state: String(form.get("state") ?? ""),
      zipcode: String(form.get("zipcode") ?? ""),
      phone: String(form.get("phone") ?? ""),
      fax: String(form.get("fax") ?? ""),
      taxId: String(form.get("taxId") ?? ""),
      email: String(form.get("email") ?? ""),
      note: String(form.get("note") ?? ""),
      coRegDate: String(form.get("coRegDate") ?? ""),
      coRegState: String(form.get("coRegState") ?? ""),
      renewMonth: String(form.get("renewMonth") ?? ""),
    };

    const alreadyAssigned = new Set(assignedServiceIds);
    const newlySelected = [...selectedServices].filter((id) => !alreadyAssigned.has(id));

    startTransition(async () => {
      try {
        const saved =
          mode === "create"
            ? await createClient(values)
            : await updateClient(client!.id, values);

        const failures: string[] = [];

        const contactFailures = await syncContacts(saved!.id);
        failures.push(...contactFailures);

        for (const projectId of newlySelected) {
          try {
            await assignProjectToClient(saved!.id, projectId);
          } catch (err) {
            const name = services.find((s) => s.id === projectId)?.name ?? projectId;
            failures.push(`${name}: ${err instanceof Error ? err.message : "couldn't assign"}`);
          }
        }

        if (failures.length > 0) {
          setError(`Client saved, but some items couldn't be saved — ${failures.join("; ")}`);
          router.refresh();
          return;
        }
        router.push(`/clients/${saved!.id}`);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't save client.");
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-6">
      <div className="rounded-lg border border-line bg-surface p-6">
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-ink-muted">
          Client
        </h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Client Name *">
            <input
              name="companyName"
              defaultValue={client?.companyName}
              required
              className={inputClass}
            />
          </Field>
          <Field label="Group Name">
            <input
              name="groupName"
              defaultValue={client?.groupName ?? ""}
              className={inputClass}
            />
          </Field>
          <Field label="Corporation Type">
            <select
              name="corpTypeId"
              defaultValue={client?.corpTypeId ?? ""}
              className={inputClass}
            >
              <option value="">— none —</option>
              {corpTypes.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Business Type">
            <select
              name="businessTypeId"
              defaultValue={client?.businessTypeId ?? ""}
              className={inputClass}
            >
              <option value="">— none —</option>
              {businessTypes.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Phone No">
            <input name="phone" defaultValue={client?.phone ?? ""} className={inputClass} />
          </Field>
          <Field label="Fax">
            <input name="fax" defaultValue={client?.fax ?? ""} className={inputClass} />
          </Field>
          <Field label="Email Address">
            <input
              name="email"
              type="email"
              defaultValue={client?.email ?? ""}
              className={inputClass}
            />
          </Field>
          <Field label="Tax ID (FIN)">
            <input name="taxId" defaultValue={client?.taxId ?? ""} className={inputClass} />
          </Field>
        </div>
      </div>

      <div className="rounded-lg border border-line bg-surface p-6">
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-muted">
            Contacts
          </h2>
          <button
            type="button"
            onClick={() => setContacts((prev) => [...prev, newDraft()])}
            className="rounded-full border border-line px-3 py-1 text-xs font-medium text-ink hover:bg-black/5"
          >
            + Add contact
          </button>
        </div>
        <p className="mb-4 text-xs text-ink-muted">
          The people you deal with at this client. Empty rows are ignored.
        </p>
        <div className="flex flex-col gap-3">
          {contacts.map((c, i) => (
            <div
              key={c.key}
              className="rounded-md border border-line bg-background/60 p-4"
            >
              <div className="mb-3 flex items-center justify-between">
                <span className="text-xs font-medium text-ink-muted">
                  Contact {i + 1}
                  {c.id ? "" : " · new"}
                </span>
                <button
                  type="button"
                  onClick={() => removeContactDraft(c.key)}
                  className="text-xs text-ink-muted hover:text-overdue"
                >
                  Remove
                </button>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="First Name">
                  <input
                    value={c.firstName}
                    onChange={(e) => updateContactDraft(c.key, { firstName: e.target.value })}
                    className={inputClass}
                  />
                </Field>
                <Field label="Last Name">
                  <input
                    value={c.lastName}
                    onChange={(e) => updateContactDraft(c.key, { lastName: e.target.value })}
                    className={inputClass}
                  />
                </Field>
                <Field label="Mobile No">
                  <input
                    value={c.mobile}
                    onChange={(e) => updateContactDraft(c.key, { mobile: e.target.value })}
                    className={inputClass}
                  />
                </Field>
                <Field label="Email">
                  <input
                    type="email"
                    value={c.email}
                    onChange={(e) => updateContactDraft(c.key, { email: e.target.value })}
                    className={inputClass}
                  />
                </Field>
                <div className="sm:col-span-2">
                  <Field label="Note">
                    <input
                      value={c.note}
                      onChange={(e) => updateContactDraft(c.key, { note: e.target.value })}
                      placeholder="Role, best time to reach, anything useful"
                      className={inputClass}
                    />
                  </Field>
                </div>
              </div>
            </div>
          ))}
          {contacts.length === 0 && (
            <p className="rounded-md border border-dashed border-line px-3 py-6 text-center text-xs text-ink-muted">
              No contacts. Use “Add contact” to add one.
            </p>
          )}
        </div>
      </div>

      <div className="rounded-lg border border-line bg-surface p-6">
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-ink-muted">
          Address
        </h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Address Line 1">
            <input name="address1" defaultValue={client?.address1 ?? ""} className={inputClass} />
          </Field>
          <Field label="Address Line 2">
            <input name="address2" defaultValue={client?.address2 ?? ""} className={inputClass} />
          </Field>
          <Field label="City">
            <input name="city" defaultValue={client?.city ?? ""} className={inputClass} />
          </Field>
          <Field label="State">
            <input name="state" defaultValue={client?.state ?? ""} className={inputClass} />
          </Field>
          <Field label="Zip Code">
            <input name="zipcode" defaultValue={client?.zipcode ?? ""} className={inputClass} />
          </Field>
        </div>
      </div>

      <div className="rounded-lg border border-line bg-surface p-6">
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-ink-muted">
          Corporate Registration
        </h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Registration Date">
            <input
              name="coRegDate"
              type="date"
              defaultValue={
                client?.coRegDate
                  ? new Date(client.coRegDate).toISOString().slice(0, 10)
                  : ""
              }
              className={inputClass}
            />
          </Field>
          <Field label="Registration State">
            <input
              name="coRegState"
              defaultValue={client?.coRegState ?? ""}
              className={inputClass}
            />
          </Field>
          <Field label="Renewal Month">
            <input
              name="renewMonth"
              defaultValue={client?.renewMonth ?? ""}
              className={inputClass}
            />
          </Field>
        </div>
      </div>

      <div className="rounded-lg border border-line bg-surface p-6">
        <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-ink-muted">
          Services
        </h2>
        <p className="mb-4 text-xs text-ink-muted">
          Which recurring projects does this client need? Checking a service assigns it
          starting this period and generates its checklist.
        </p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {services.map((s) => {
            const disabled = s.stepCount === 0 && !assignedServiceIds.includes(s.id);
            return (
              <label
                key={s.id}
                className={`flex items-start gap-2 rounded-md border border-line p-3 text-sm ${
                  disabled ? "opacity-50" : "hover:bg-black/[0.02]"
                }`}
              >
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={selectedServices.has(s.id)}
                  disabled={disabled}
                  onChange={() => toggleService(s.id)}
                />
                <span>
                  <span className="block font-medium text-ink">{s.name}</span>
                  <span className="block text-xs text-ink-muted">
                    {RECURRING_LABELS[s.recurring] ?? s.recurring}
                    {disabled && " · checklist not configured yet"}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      </div>

      <div className="rounded-lg border border-line bg-surface p-6">
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-ink-muted">
          Note
        </h2>
        <textarea
          name="note"
          rows={3}
          defaultValue={client?.note ?? ""}
          className={inputClass}
        />
      </div>

      {error && <p className="text-sm text-overdue">{error}</p>}

      <div className="flex gap-3">
        <button
          type="submit"
          disabled={isPending}
          className="rounded-full bg-accent px-5 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {isPending ? "Saving…" : mode === "create" ? "Create Client" : "Save Changes"}
        </button>
        <button
          type="button"
          onClick={() => router.back()}
          className="rounded-full border border-line px-5 py-2 text-sm font-medium text-ink hover:bg-black/5"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
