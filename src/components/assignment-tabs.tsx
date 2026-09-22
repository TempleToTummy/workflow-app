import Link from "next/link";

export type AssignmentTab = "list" | "files" | "notes" | "time";

const TABS: { id: AssignmentTab; label: string }[] = [
  { id: "list", label: "List" },
  { id: "files", label: "Files" },
  { id: "notes", label: "Notes" },
  { id: "time", label: "Time" },
];

// Underline tab bar for the assignment detail page. Driven by the `?tab=`
// search param so a tab survives a refresh and is linkable; `list` is the
// default and renders without the param. When a past period is being viewed
// (`?period=`), every tab link carries it along.
export function AssignmentTabs({
  basePath,
  active,
  counts,
  period,
}: {
  basePath: string;
  active: AssignmentTab;
  counts?: Partial<Record<AssignmentTab, number>>;
  period?: string | null;
}) {
  return (
    <nav className="mt-6 flex gap-6 border-b border-line">
      {TABS.map((tab) => {
        const isActive = tab.id === active;
        const params = new URLSearchParams();
        if (tab.id !== "list") params.set("tab", tab.id);
        if (period) params.set("period", period);
        const query = params.toString();
        const href = query ? `${basePath}?${query}` : basePath;
        const count = counts?.[tab.id];
        return (
          <Link
            key={tab.id}
            href={href}
            scroll={false}
            className={`-mb-px flex items-center gap-1.5 border-b-2 px-1 pb-3 text-sm font-medium transition-colors ${
              isActive
                ? "border-accent text-ink"
                : "border-transparent text-ink-muted hover:text-ink"
            }`}
          >
            {tab.label}
            {typeof count === "number" && count > 0 && (
              <span className="tabular rounded-full bg-black/5 px-1.5 text-[11px] text-ink-muted">
                {count}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
