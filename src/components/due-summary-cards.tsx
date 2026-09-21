import Link from "next/link";
import type { DueFilter } from "@/lib/dates";

const CARDS: { id: DueFilter; label: string }[] = [
  { id: "today", label: "Due Today" },
  { id: "this-week", label: "Due This Week" },
  { id: "next-week", label: "Due Next Week" },
  { id: "overdue", label: "Overdue" },
];

// The four at-a-glance counters above the dashboard table. Each card is a link
// that sets (or, when already active, clears) the ?due= filter while keeping
// every other filter in place.
export function DueSummaryCards({
  counts,
  active,
  otherParams,
}: {
  counts: Record<DueFilter, number>;
  active: DueFilter | null;
  otherParams: URLSearchParams;
}) {
  return (
    <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
      {CARDS.map((card) => {
        const isActive = active === card.id;
        const params = new URLSearchParams(otherParams);
        if (!isActive) params.set("due", card.id);
        const query = params.toString();
        const href = query ? `/?${query}` : "/";
        const count = counts[card.id];
        const isOverdue = card.id === "overdue";
        return (
          <Link
            key={card.id}
            href={href}
            aria-pressed={isActive}
            className={`group flex items-center justify-between gap-3 rounded-lg border bg-surface px-4 py-3 shadow-sm transition-colors ${
              isActive
                ? "border-accent ring-1 ring-accent/30"
                : "border-line hover:border-ink-muted/40"
            }`}
          >
            <span className="flex items-baseline gap-2">
              <span
                className={`tabular text-lg font-semibold ${
                  isOverdue && count > 0 ? "text-overdue" : count > 0 ? "text-accent" : "text-ink-muted"
                }`}
              >
                {count}
              </span>
              <span className="text-sm font-medium text-ink">{card.label}</span>
            </span>
            <span
              aria-hidden
              className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md border text-ink-muted transition-colors ${
                isActive
                  ? "border-accent bg-accent text-white"
                  : "border-line group-hover:border-ink-muted/40 group-hover:text-ink"
              }`}
            >
              <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none">
                {isActive ? (
                  <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                ) : (
                  <path d="M4 10h12m-5-5l5 5-5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                )}
              </svg>
            </span>
          </Link>
        );
      })}
    </div>
  );
}
