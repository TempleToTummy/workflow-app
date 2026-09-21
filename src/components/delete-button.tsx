"use client";

import { useState, useTransition } from "react";

export function DeleteButton({
  onDelete,
  confirmMessage = "Delete this? This can't be undone.",
  label = "Delete",
  className = "text-xs text-ink-muted hover:text-overdue disabled:opacity-50",
  onSuccess,
}: {
  onDelete: () => Promise<void>;
  confirmMessage?: string;
  label?: string;
  className?: string;
  onSuccess?: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleClick() {
    if (!window.confirm(confirmMessage)) return;
    setError(null);
    startTransition(async () => {
      try {
        await onDelete();
        onSuccess?.();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't delete that.");
      }
    });
  }

  return (
    <span className="inline-flex flex-col items-end gap-1">
      <button onClick={handleClick} disabled={isPending} className={className}>
        {label}
      </button>
      {error && <span className="text-xs text-overdue">{error}</span>}
    </span>
  );
}
