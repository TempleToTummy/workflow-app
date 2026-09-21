"use client";

import { useState, useTransition } from "react";

export function LookupManager({
  title,
  items,
  onCreate,
  onDelete,
}: {
  title: string;
  items: { id: string; name: string }[];
  onCreate: (name: string) => Promise<unknown>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      try {
        await onCreate(name);
        setName("");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't add that.");
      }
    });
  }

  function handleDelete(id: string) {
    setError(null);
    startTransition(async () => {
      try {
        await onDelete(id);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't delete that.");
      }
    });
  }

  return (
    <div className="rounded-lg border border-line bg-surface p-6">
      <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-ink-muted">
        {title}
      </h2>
      <ul className="mb-4 flex flex-col gap-1">
        {items.map((item) => (
          <li
            key={item.id}
            className="flex items-center justify-between rounded-md px-2 py-1.5 text-sm hover:bg-black/[0.02]"
          >
            <span className="text-ink">{item.name}</span>
            <button
              onClick={() => handleDelete(item.id)}
              disabled={isPending}
              className="text-xs text-ink-muted hover:text-overdue disabled:opacity-50"
            >
              Delete
            </button>
          </li>
        ))}
        {items.length === 0 && (
          <li className="px-2 py-4 text-center text-sm text-ink-muted">None yet.</li>
        )}
      </ul>
      <form onSubmit={handleCreate} className="flex gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New name"
          className="flex-1 rounded-md border border-line bg-surface px-3 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40"
        />
        <button
          type="submit"
          disabled={isPending || !name.trim()}
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          Add
        </button>
      </form>
      {error && <p className="mt-2 text-xs text-overdue">{error}</p>}
    </div>
  );
}
