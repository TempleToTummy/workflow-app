"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { createSavedView, deleteSavedView } from "@/lib/organize-actions";
import { sanitizeViewQuery, viewHref, MAX_VIEW_NAME_LENGTH, type SavedViewPath } from "@/lib/saved-views";

export type SavedViewItem = {
  id: string;
  name: string;
  query: string;
  shared: boolean;
  mine: boolean;
};

// "Views ▾" — named filter combinations for a list page. Picking one is just
// navigating to its URL; the button shows which view (if any) the current
// filters match.
export function SavedViewsMenu({
  path,
  views,
  isAdmin,
}: {
  path: SavedViewPath;
  views: SavedViewItem[];
  isAdmin: boolean;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [share, setShare] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const ref = useRef<HTMLDivElement>(null);

  const current = sanitizeViewQuery(path, searchParams.toString());
  const active = views.find((v) => v.query === current && current !== "");

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

  function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      try {
        await createSavedView({ name, path, query: current, shared: share });
        setName("");
        setShare(false);
        setSaving(false);
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't save the view.");
      }
    });
  }

  function remove(id: string) {
    setError(null);
    startTransition(async () => {
      try {
        await deleteSavedView(id);
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't delete the view.");
      }
    });
  }

  const mine = views.filter((v) => v.mine && !v.shared);
  const shared = views.filter((v) => v.shared);

  function Item({ v }: { v: SavedViewItem }) {
    const canDelete = v.mine || (v.shared && isAdmin);
    return (
      <div
        className={`group flex items-center justify-between gap-2 rounded px-2.5 py-1.5 text-sm ${
          active?.id === v.id ? "bg-accent-soft text-accent" : "text-ink hover:bg-black/[0.03]"
        }`}
      >
        <Link href={viewHref(path, v.query)} onClick={() => setOpen(false)} className="min-w-0 flex-1 truncate">
          {v.name}
        </Link>
        {canDelete && (
          <button
            type="button"
            onClick={() => remove(v.id)}
            disabled={isPending}
            aria-label={`Delete view ${v.name}`}
            className="text-ink-muted opacity-0 hover:text-overdue group-hover:opacity-100 focus:opacity-100"
          >
            ×
          </button>
        )}
      </div>
    );
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-sm transition-colors ${
          active ? "border-accent/40 bg-accent-soft text-accent" : "border-line bg-surface text-ink hover:border-ink-muted/40"
        }`}
      >
        <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none" aria-hidden>
          <path d="M5 3.5h10a1 1 0 011 1V17l-6-3.5L4 17V4.5a1 1 0 011-1z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
        </svg>
        <span className="font-medium">Views</span>
        {active && <span className="max-w-40 truncate">· {active.name}</span>}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 w-72 rounded-md border border-line bg-surface p-1 shadow-lg">
          {views.length === 0 && (
            <p className="px-2.5 py-2 text-xs text-ink-muted">
              No saved views yet. Set up the filters you use often, then save them here.
            </p>
          )}
          {mine.length > 0 && (
            <>
              <p className="px-2.5 pt-1.5 pb-1 text-[11px] font-medium uppercase tracking-wide text-ink-muted">My views</p>
              {mine.map((v) => (
                <Item key={v.id} v={v} />
              ))}
            </>
          )}
          {shared.length > 0 && (
            <>
              <p className="px-2.5 pt-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-ink-muted">Team views</p>
              {shared.map((v) => (
                <Item key={v.id} v={v} />
              ))}
            </>
          )}

          <div className="mt-1 border-t border-line pt-1">
            {saving ? (
              <form onSubmit={save} className="flex flex-col gap-2 p-2">
                <input
                  autoFocus
                  value={name}
                  maxLength={MAX_VIEW_NAME_LENGTH}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. My overdue bookkeeping"
                  aria-label="View name"
                  className="rounded-md border border-line bg-surface px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-accent/40"
                />
                {isAdmin && (
                  <label className="flex items-center gap-2 text-xs text-ink-muted">
                    <input type="checkbox" checked={share} onChange={(e) => setShare(e.target.checked)} />
                    Share with the whole team
                  </label>
                )}
                <p className="text-[11px] text-ink-muted">
                  {current ? "Saves the filters currently applied." : "No filters are applied — this view will show everything."}
                </p>
                <div className="flex gap-2">
                  <button
                    type="submit"
                    disabled={isPending || !name.trim()}
                    className="whitespace-nowrap rounded-full bg-accent px-3 py-1 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
                  >
                    Save view
                  </button>
                  <button
                    type="button"
                    onClick={() => setSaving(false)}
                    className="rounded-md border border-line px-3 py-1 text-xs text-ink hover:bg-black/5"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <button
                type="button"
                onClick={() => setSaving(true)}
                className="w-full rounded px-2.5 py-1.5 text-left text-sm text-accent hover:bg-black/[0.03]"
              >
                + Save current view…
              </button>
            )}
            {error && <p className="px-2.5 pb-1.5 text-xs text-overdue">{error}</p>}
          </div>
        </div>
      )}
    </div>
  );
}
