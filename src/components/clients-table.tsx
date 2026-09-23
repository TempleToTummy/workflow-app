"use client";

import { Fragment, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { bulkOrganizeClients } from "@/lib/organize-actions";
import { TagPill, type TagChip } from "@/components/client-tag-editor";

export type ClientRow = {
  id: string;
  name: string;
  groupName: string | null;
  businessType: string | null;
  phone: string | null;
  email: string | null;
  tags: TagChip[];
};

const inputClass =
  "rounded-md border border-line bg-surface px-2 py-1 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40";
const buttonClass =
  "rounded-md border border-line bg-surface px-2.5 py-1 text-sm font-medium text-ink hover:bg-black/5 disabled:opacity-50";

// The clients list, with row selection and a bulk bar for tagging and
// grouping many clients at once. Grouped mode renders a section per
// Client.groupName.
export function ClientsTable({
  rows,
  groupBy,
  allTags,
  groupSuggestions,
  selectable,
}: {
  rows: ClientRow[];
  groupBy: boolean;
  allTags: TagChip[];
  groupSuggestions: string[];
  selectable: boolean;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [tagText, setTagText] = useState("");
  const [groupText, setGroupText] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // Drop selections that a filter change has taken off the screen, so the bulk
  // bar never acts on rows the user can't see.
  const visibleIds = useMemo(() => new Set(rows.map((r) => r.id)), [rows]);
  const selectedVisible = [...selected].filter((id) => visibleIds.has(id));
  const allSelected = rows.length > 0 && selectedVisible.length === rows.length;

  const sections = useMemo(() => {
    if (!groupBy) return [{ key: "all", label: null as string | null, rows }];
    const map = new Map<string, ClientRow[]>();
    for (const r of rows) {
      const key = r.groupName?.trim() || "";
      map.set(key, [...(map.get(key) ?? []), r]);
    }
    return [...map.entries()]
      .sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)))
      .map(([key, list]) => ({ key: key || "__none", label: key || "No group", rows: list }));
  }, [rows, groupBy]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)));
  }

  function run(op: Parameters<typeof bulkOrganizeClients>[1], describe: (n: number) => string) {
    setError(null);
    setMessage(null);
    startTransition(async () => {
      try {
        const { changed, skipped } = await bulkOrganizeClients(selectedVisible, op);
        setMessage(
          `${describe(changed)}${
            skipped > 0 ? ` ${skipped} skipped — you don't work with ${skipped === 1 ? "that client" : "those clients"}.` : ""
          }`
        );
        setTagText("");
        setGroupText("");
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "That didn't work.");
      }
    });
  }

  const plural = (n: number) => `${n} client${n === 1 ? "" : "s"}`;
  const colSpan = selectable ? 6 : 5;

  return (
    <div>
      {selectable && selectedVisible.length > 0 && (
        <div className="sticky top-0 z-10 mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-accent/30 bg-accent-soft px-4 py-2.5 shadow-sm">
          <span className="text-sm font-medium text-accent">{plural(selectedVisible.length)} selected</span>
          <form
            className="flex items-center gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              if (tagText.trim()) {
                const name = tagText.trim();
                run({ kind: "add-tag", tagName: name }, (n) => `Tagged ${plural(n)} “${name}”.`);
              }
            }}
          >
            <input
              value={tagText}
              onChange={(e) => setTagText(e.target.value)}
              list="bulk-tag-suggestions"
              placeholder="Tag name"
              aria-label="Tag to add"
              className={`${inputClass} w-32`}
            />
            <datalist id="bulk-tag-suggestions">
              {allTags.map((t) => (
                <option key={t.id} value={t.name} />
              ))}
            </datalist>
            <button type="submit" disabled={isPending || !tagText.trim()} className={buttonClass}>
              Add tag
            </button>
          </form>
          <form
            className="flex items-center gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              if (groupText.trim()) {
                const name = groupText.trim();
                run({ kind: "set-group", groupName: name }, (n) => `Moved ${plural(n)} into “${name}”.`);
              }
            }}
          >
            <input
              value={groupText}
              onChange={(e) => setGroupText(e.target.value)}
              list="bulk-group-suggestions"
              placeholder="Group name"
              aria-label="Group to move into"
              className={`${inputClass} w-36`}
            />
            <datalist id="bulk-group-suggestions">
              {groupSuggestions.map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>
            <button type="submit" disabled={isPending || !groupText.trim()} className={buttonClass}>
              Set group
            </button>
          </form>
          <button
            type="button"
            disabled={isPending}
            onClick={() => run({ kind: "set-group", groupName: null }, (n) => `Removed ${plural(n)} from their group.`)}
            className={buttonClass}
          >
            Clear group
          </button>
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            className="ml-auto text-sm text-ink-muted underline decoration-dotted underline-offset-2 hover:text-ink"
          >
            Clear selection
          </button>
        </div>
      )}
      {message && <p className="mb-2 text-sm text-accent">{message}</p>}
      {error && <p className="mb-2 text-sm text-overdue">{error}</p>}

      <div className="overflow-hidden rounded-lg border border-line bg-surface">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-line bg-black/[0.02] text-xs uppercase tracking-wide text-ink-muted">
              {selectable && (
                <th className="w-10 px-4 py-3">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleAll}
                    aria-label={allSelected ? "Deselect all clients" : "Select all clients shown"}
                  />
                </th>
              )}
              <th className="px-4 py-3 font-medium">Client</th>
              <th className="px-4 py-3 font-medium">Group</th>
              <th className="px-4 py-3 font-medium">Business Type</th>
              <th className="px-4 py-3 font-medium">Phone</th>
              <th className="px-4 py-3 font-medium">Email</th>
            </tr>
          </thead>
          <tbody>
            {sections.map((section) => (
              <Fragment key={section.key}>
                {section.label !== null && (
                  <tr className="border-b border-line bg-black/[0.03]">
                    <td colSpan={colSpan} className="px-4 py-2 text-[11px] font-medium uppercase tracking-wide text-ink-muted">
                      {section.label} · {section.rows.length}
                    </td>
                  </tr>
                )}
                {section.rows.map((c) => (
                  <tr
                    key={c.id}
                    className={`border-b border-line last:border-0 hover:bg-black/[0.015] ${
                      selected.has(c.id) ? "bg-accent-soft/50" : ""
                    }`}
                  >
                    {selectable && (
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          checked={selected.has(c.id)}
                          onChange={() => toggle(c.id)}
                          aria-label={`Select ${c.name}`}
                        />
                      </td>
                    )}
                    <td className="px-4 py-3">
                      <Link href={`/clients/${c.id}`} className="font-medium text-ink hover:text-accent">
                        {c.name}
                      </Link>
                      {c.tags.length > 0 && (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {c.tags.map((t) => (
                            <TagPill key={t.id} tag={t} />
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-ink-muted">{c.groupName ?? "—"}</td>
                    <td className="px-4 py-3 text-ink-muted">{c.businessType ?? "—"}</td>
                    <td className="px-4 py-3 text-ink-muted">{c.phone ?? "—"}</td>
                    <td className="px-4 py-3 text-ink-muted">{c.email ?? "—"}</td>
                  </tr>
                ))}
              </Fragment>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={colSpan} className="px-4 py-10 text-center text-ink-muted">
                  No clients match.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
