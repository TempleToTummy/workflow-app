"use client";

import { useEffect, useState, useTransition } from "react";
import { revealClientTaxId, revealContactSsn } from "@/lib/actions";

// A tax ID or SSN, shown masked (••-•••1234). "Reveal" fetches the full value
// from the server — an audited, rate-limited action — and it hides itself
// again after 30 seconds so it isn't left on a screen somebody walks past.
// The full value is never part of the page's HTML or its React payload.

const VISIBLE_FOR_MS = 30_000;

export function SensitiveValue({
  kind,
  id,
  masked,
}: {
  kind: "taxId" | "ssn";
  id: string;
  masked: string | null;
}) {
  const [value, setValue] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    if (!value) return;
    const t = setTimeout(() => setValue(null), VISIBLE_FOR_MS);
    return () => clearTimeout(t);
  }, [value]);

  if (!masked) return <span>—</span>;

  function reveal() {
    setError(null);
    startTransition(async () => {
      try {
        setValue(kind === "taxId" ? await revealClientTaxId(id) : await revealContactSsn(id));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't show it.");
      }
    });
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span className="tabular font-mono">{value ?? masked}</span>
      <button
        type="button"
        onClick={value ? () => setValue(null) : reveal}
        disabled={isPending}
        className="text-xs font-medium text-accent hover:underline disabled:opacity-50"
        title={value ? undefined : "Viewing the full number is recorded in the activity log"}
      >
        {isPending ? "…" : value ? "Hide" : "Reveal"}
      </button>
      {error && <span className="text-xs text-overdue">{error}</span>}
    </span>
  );
}
