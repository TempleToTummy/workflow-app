"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

// The search field — used in the sidebar (compact) and on /search itself.
// Submitting goes to /search?q=…; pressing "/" anywhere that isn't a text
// field jumps to the sidebar box, the convention most web apps use.
export function SearchBox({
  initial = "",
  compact = false,
  autoFocus = false,
}: {
  initial?: string;
  compact?: boolean;
  autoFocus?: boolean;
}) {
  const router = useRouter();
  const [text, setText] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!compact) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return;
      e.preventDefault();
      ref.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [compact]);

  return (
    <form
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        const q = text.trim();
        if (q) router.push(`/search?q=${encodeURIComponent(q)}`);
      }}
      className={
        compact
          ? "flex items-center gap-2 rounded-md border border-sidebar-border bg-sidebar-hover/40 px-2.5 py-1.5 focus-within:border-sidebar-active-ink/50"
          : "flex items-center gap-2 rounded-md border border-line bg-surface px-3 py-2 focus-within:border-accent/50 focus-within:ring-2 focus-within:ring-accent/15"
      }
    >
      <svg viewBox="0 0 20 20" className={`h-4 w-4 shrink-0 ${compact ? "text-sidebar-ink-muted" : "text-ink-muted"}`} fill="none" aria-hidden>
        <circle cx="9" cy="9" r="5.5" stroke="currentColor" strokeWidth="1.6" />
        <path d="M13.5 13.5L17 17" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
      <input
        ref={ref}
        type="search"
        value={text}
        autoFocus={autoFocus}
        onChange={(e) => setText(e.target.value)}
        placeholder={compact ? "Search…" : "Search clients, tasks, notes, files, email…"}
        aria-label="Search everything"
        className={`min-w-0 flex-1 bg-transparent text-sm focus:outline-none ${
          compact ? "text-sidebar-ink placeholder:text-sidebar-ink-muted" : "text-ink placeholder:text-ink-muted/70"
        }`}
      />
      {compact && (
        <kbd className="hidden rounded border border-sidebar-border px-1 text-[10px] text-sidebar-ink-muted sm:inline">/</kbd>
      )}
    </form>
  );
}
