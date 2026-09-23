"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { NO_GROUP } from "@/lib/client-filters";

type Option = { value: string; label: string };

// --- icons (16px, stroke-based, inherit currentColor) ----------------------

const Icon = {
  search: (
    <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" aria-hidden>
      <circle cx="9" cy="9" r="5.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M13.5 13.5L17 17" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  ),
  calendar: (
    <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none" aria-hidden>
      <rect x="3" y="4.5" width="14" height="12" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M3 8.5h14M7 3v3M13 3v3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  ),
  period: (
    <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none" aria-hidden>
      <rect x="3" y="4.5" width="14" height="12" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M3 8.5h14M7 12h2M11 12h2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  ),
  person: (
    <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none" aria-hidden>
      <circle cx="10" cy="7" r="3.2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M4 17c.8-3 3-4.5 6-4.5s5.2 1.5 6 4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  ),
  people: (
    <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none" aria-hidden>
      <circle cx="7.5" cy="7" r="2.8" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="13.5" cy="8" r="2.2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M2.5 16c.6-2.6 2.5-4 5-4s4.4 1.4 5 4M12.5 12.5c2 .1 3.5 1.2 4 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  ),
  folder: (
    <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none" aria-hidden>
      <path d="M3 6.5A1.5 1.5 0 014.5 5h3.4l1.6 1.8h6A1.5 1.5 0 0117 8.3v6.2a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 013 14.5v-8z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  ),
  status: (
    <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none" aria-hidden>
      <circle cx="10" cy="10" r="6.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M7.2 10.2l2 2 3.8-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  group: (
    <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none" aria-hidden>
      <rect x="3" y="3" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
      <rect x="11" y="3" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
      <rect x="3" y="11" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
      <rect x="11" y="11" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  ),
  tag: (
    <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none" aria-hidden>
      <path d="M3 10.2V4.5A1.5 1.5 0 014.5 3h5.7L17 9.8a1.5 1.5 0 010 2.1l-5.1 5.1a1.5 1.5 0 01-2.1 0L3 10.2z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <circle cx="7" cy="7" r="1.2" fill="currentColor" />
    </svg>
  ),
  caret: (
    <svg viewBox="0 0 20 20" className="h-3 w-3" fill="currentColor" aria-hidden>
      <path d="M5.5 7.5l4.5 5 4.5-5z" />
    </svg>
  ),
  check: (
    <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none" aria-hidden>
      <path d="M4.5 10.5l3.5 3.5 7.5-8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
};

// A pill that opens a single-select menu. Shows the chosen value inline and
// tints itself when something is selected, so active filters are obvious.
function FilterChip({
  icon,
  label,
  value,
  onChange,
  options,
  allLabel,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Option[];
  allLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const selected = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function pick(v: string) {
    onChange(v);
    setOpen(false);
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="listbox"
        className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-sm transition-colors ${
          selected
            ? "border-accent/40 bg-accent-soft text-accent"
            : "border-line bg-surface text-ink hover:border-ink-muted/40"
        }`}
      >
        <span className={selected ? "text-accent" : "text-ink-muted"}>{icon}</span>
        <span className="font-medium">{label}</span>
        {selected && (
          <span className="max-w-40 truncate font-normal">· {selected.label}</span>
        )}
        <span className={selected ? "text-accent" : "text-ink-muted"}>{Icon.caret}</span>
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute left-0 top-full z-20 mt-1 max-h-72 min-w-52 overflow-y-auto rounded-md border border-line bg-surface p-1 shadow-lg"
        >
          <button
            type="button"
            role="option"
            aria-selected={!value}
            onClick={() => pick("")}
            className={`flex w-full items-center justify-between rounded px-2.5 py-1.5 text-left text-sm ${
              !value ? "font-medium text-ink" : "text-ink-muted hover:bg-black/[0.03] hover:text-ink"
            }`}
          >
            {allLabel}
            {!value && <span className="text-accent">{Icon.check}</span>}
          </button>
          {options.map((o) => {
            const active = o.value === value;
            return (
              <button
                key={o.value}
                type="button"
                role="option"
                aria-selected={active}
                onClick={() => pick(o.value)}
                className={`flex w-full items-center justify-between gap-3 rounded px-2.5 py-1.5 text-left text-sm ${
                  active ? "bg-accent-soft font-medium text-accent" : "text-ink hover:bg-black/[0.03]"
                }`}
              >
                <span className="truncate">{o.label}</span>
                {active && <span className="shrink-0">{Icon.check}</span>}
              </button>
            );
          })}
          {options.length === 0 && (
            <p className="px-2.5 py-2 text-xs text-ink-muted">Nothing to filter by yet.</p>
          )}
        </div>
      )}
    </div>
  );
}

const STATUS_OPTIONS: Option[] = [
  { value: "NOT_STARTED", label: "Not started" },
  { value: "IN_PROGRESS", label: "In progress" },
  { value: "AWAITING_REVIEW", label: "Awaiting review" },
  { value: "DONE", label: "Done" },
];

const DUE_OPTIONS: Option[] = [
  { value: "overdue", label: "Overdue" },
  { value: "today", label: "Due today" },
  { value: "this-week", label: "Due this week" },
  { value: "next-week", label: "Due next week" },
];

const FILTER_KEYS = ["q", "status", "clientId", "assigneeId", "projectId", "period", "due", "group", "tag"];

// Search + filter chips, driven entirely by the URL so every view is linkable.
// Pages opt in to the extra chips by passing their options; /tasks and the
// admin activity page keep the original status / client / assignee trio.
export function FilterBar({
  clients,
  employees,
  projects,
  periods,
  groups,
  tags,
  search = false,
  searchPlaceholder = "Search…",
  due = false,
  statuses,
  trailing,
}: {
  // Omit to hide the Client chip (the Clients page itself filters by name).
  clients?: Option[];
  employees?: Option[];
  projects?: Option[];
  periods?: Option[];
  // Client groups (Client.groupName) and tags. Omitted = chip hidden.
  groups?: Option[];
  tags?: Option[];
  search?: boolean;
  searchPlaceholder?: string;
  due?: boolean;
  // The Status chip defaults to the ClientActivity statuses. Pass a different
  // list to filter on something else (Email uses its own), or null to hide the
  // chip entirely on a page where it has no meaning.
  statuses?: Option[] | null;
  trailing?: ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function buildUrl(mutate: (p: URLSearchParams) => void): string {
    const params = new URLSearchParams(searchParams.toString());
    mutate(params);
    const query = params.toString();
    return query ? `${pathname}?${query}` : pathname;
  }

  function setParam(key: string, value: string) {
    router.push(
      buildUrl((p) => {
        if (value) p.set(key, value);
        else p.delete(key);
      })
    );
  }

  // Search is debounced and uses replace() so typing doesn't spam history.
  const urlQuery = searchParams.get("q") ?? "";
  const [text, setText] = useState(urlQuery);
  const [syncedFrom, setSyncedFrom] = useState(urlQuery);
  if (urlQuery !== syncedFrom) {
    setSyncedFrom(urlQuery);
    setText(urlQuery);
  }
  useEffect(() => {
    if (text === urlQuery) return;
    const t = setTimeout(() => {
      router.replace(
        buildUrl((p) => {
          if (text.trim()) p.set("q", text.trim());
          else p.delete("q");
        })
      );
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  const hasFilters = FILTER_KEYS.some((k) => searchParams.get(k));

  return (
    <div className="flex flex-col gap-3">
      {(search || trailing) && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          {search && (
            <label className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-line bg-surface px-3 py-2 transition-colors focus-within:border-accent/50 focus-within:ring-2 focus-within:ring-accent/15 sm:max-w-md">
              <span className="text-ink-muted">{Icon.search}</span>
              <input
                type="search"
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={searchPlaceholder}
                aria-label={searchPlaceholder}
                className="min-w-0 flex-1 bg-transparent text-sm text-ink placeholder:text-ink-muted/70 focus:outline-none"
              />
              {text && (
                <button
                  type="button"
                  onClick={() => setText("")}
                  aria-label="Clear search"
                  className="text-ink-muted hover:text-ink"
                >
                  ×
                </button>
              )}
            </label>
          )}
          {trailing}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {due && (
          <FilterChip
            icon={Icon.calendar}
            label="Due Date"
            allLabel="Any due date"
            value={searchParams.get("due") ?? ""}
            onChange={(v) => setParam("due", v)}
            options={DUE_OPTIONS}
          />
        )}
        {periods && (
          <FilterChip
            icon={Icon.period}
            label="Accounting Period"
            allLabel="All periods"
            value={searchParams.get("period") ?? ""}
            onChange={(v) => setParam("period", v)}
            options={periods}
          />
        )}
        {employees && (
          <FilterChip
            icon={Icon.person}
            label="Assignee"
            allLabel="Everyone"
            value={searchParams.get("assigneeId") ?? ""}
            onChange={(v) => setParam("assigneeId", v)}
            options={employees}
          />
        )}
        {clients && (
          <FilterChip
            icon={Icon.people}
            label="Client"
            allLabel="All clients"
            value={searchParams.get("clientId") ?? ""}
            onChange={(v) => setParam("clientId", v)}
            options={clients}
          />
        )}
        {groups && (
          <FilterChip
            icon={Icon.group}
            label="Group"
            allLabel="All groups"
            value={searchParams.get("group") ?? ""}
            onChange={(v) => setParam("group", v)}
            options={[...groups, { value: NO_GROUP, label: "(No group)" }]}
          />
        )}
        {tags && (
          <FilterChip
            icon={Icon.tag}
            label="Tag"
            allLabel="Any tag"
            value={searchParams.get("tag") ?? ""}
            onChange={(v) => setParam("tag", v)}
            options={tags}
          />
        )}
        {projects && (
          <FilterChip
            icon={Icon.folder}
            label="Project"
            allLabel="All projects"
            value={searchParams.get("projectId") ?? ""}
            onChange={(v) => setParam("projectId", v)}
            options={projects}
          />
        )}
        {statuses !== null && (
          <FilterChip
            icon={Icon.status}
            label="Status"
            allLabel="All statuses"
            value={searchParams.get("status") ?? ""}
            onChange={(v) => setParam("status", v)}
            options={statuses ?? STATUS_OPTIONS}
          />
        )}
        {hasFilters && (
          <button
            type="button"
            onClick={() =>
              // Clears the filters but keeps page-level switches (a view tab,
              // the archived toggle), which aren't filters.
              router.push(
                buildUrl((p) => {
                  for (const k of FILTER_KEYS) p.delete(k);
                })
              )
            }
            className="ml-1 text-sm text-ink-muted underline decoration-dotted underline-offset-2 hover:text-accent"
          >
            Clear filters
          </button>
        )}
      </div>
    </div>
  );
}
