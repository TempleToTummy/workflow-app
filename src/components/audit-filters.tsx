"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";

type Option = { value: string; label: string };

// Filters for the audit log. A plain set of selects rather than the dashboard's
// FilterBar: that component is built around the work-tracking params
// (status / due / period) and the audit log filters on a different axis
// entirely — action, actor, client. Reusing it would have meant bending it out
// of shape for one caller.
export function AuditFilters({
  groups,
  clients,
  actors,
  total,
}: {
  groups: { heading: string; options: Option[] }[];
  clients: Option[];
  actors: Option[];
  total: number;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function setParam(key: string, value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value) params.set(key, value);
    else params.delete(key);
    // Any filter change invalidates the current page number.
    params.delete("page");
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname);
  }

  const selectClass =
    "rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40";

  const hasFilters = ["action", "actorId", "clientId"].some((k) => searchParams.get(k));

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        value={searchParams.get("action") ?? ""}
        onChange={(e) => setParam("action", e.target.value)}
        aria-label="Filter by what changed"
        className={selectClass}
      >
        <option value="">Anything</option>
        {groups.map((g) => (
          <optgroup key={g.heading} label={g.heading}>
            {g.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>

      <select
        value={searchParams.get("actorId") ?? ""}
        onChange={(e) => setParam("actorId", e.target.value)}
        aria-label="Filter by who did it"
        className={selectClass}
      >
        <option value="">Anyone</option>
        {actors.map((a) => (
          <option key={a.value} value={a.value}>
            {a.label}
          </option>
        ))}
      </select>

      <select
        value={searchParams.get("clientId") ?? ""}
        onChange={(e) => setParam("clientId", e.target.value)}
        aria-label="Filter by client"
        className={selectClass}
      >
        <option value="">All clients</option>
        {clients.map((c) => (
          <option key={c.value} value={c.value}>
            {c.label}
          </option>
        ))}
      </select>

      {hasFilters && (
        <button
          type="button"
          onClick={() => router.push(pathname)}
          className="text-sm text-ink-muted underline decoration-dotted underline-offset-2 hover:text-accent"
        >
          Clear
        </button>
      )}

      <span className="tabular ml-auto whitespace-nowrap text-sm text-ink-muted">
        {total} {total === 1 ? "event" : "events"}
      </span>
    </div>
  );
}
