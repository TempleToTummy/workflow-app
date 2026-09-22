"use client";

import { useState } from "react";

// The Export CSV / Print pair that sits at the top right of every report.
//
// Both controls carry `no-print`, so they don't appear on the page they
// produce — a printout with a "Print" button on it looks like a screenshot.
//
// Export is a plain <a download>, not a fetch: the browser's own download
// handling deals with the file, the progress and the disk, and none of that
// needs to be reimplemented. The only state here is a brief "Preparing…" so a
// large report doesn't feel like a dead click.
export function ExportBar({
  reportKey,
  // Extra query to carry the page's current filters into the export, so what
  // downloads is what's on screen rather than the unfiltered table.
  query,
  printable = true,
}: {
  reportKey: string;
  query?: Record<string, string | null | undefined>;
  printable?: boolean;
}) {
  const [preparing, setPreparing] = useState(false);

  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value) search.set(key, value);
  }
  const href = `/api/export/${reportKey}${search.toString() ? `?${search}` : ""}`;

  return (
    <div className="no-print flex shrink-0 items-center gap-2">
      <a
        href={href}
        download
        onClick={() => {
          setPreparing(true);
          // There is no load event for a download, so the label is cleared on
          // a timer. It's cosmetic: the anchor works whether or not this runs.
          window.setTimeout(() => setPreparing(false), 2500);
        }}
        className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1.5 text-xs font-medium text-ink transition-colors hover:bg-black/5"
      >
        <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none" aria-hidden>
          <path
            d="M10 3v9m0 0l-3.2-3.2M10 12l3.2-3.2M4 14.5v1A1.5 1.5 0 005.5 17h9a1.5 1.5 0 001.5-1.5v-1"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        {preparing ? "Preparing…" : "Export CSV"}
      </a>

      {printable && (
        <button
          type="button"
          onClick={() => window.print()}
          className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1.5 text-xs font-medium text-ink transition-colors hover:bg-black/5"
        >
          <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none" aria-hidden>
            <path
              d="M6 7V3.5h8V7M6 14H4.5A1.5 1.5 0 013 12.5v-3A1.5 1.5 0 014.5 8h11A1.5 1.5 0 0117 9.5v3a1.5 1.5 0 01-1.5 1.5H14M6 12h8v4.5H6V12z"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          Print
        </button>
      )}
    </div>
  );
}
