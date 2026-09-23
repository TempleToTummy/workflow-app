"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { updateTag, deleteTag } from "@/lib/organize-actions";
import { TAG_COLOR_KEYS, tagClasses, MAX_TAG_LENGTH } from "@/lib/tags";

type Row = { id: string; name: string; color: string; clients: number };

export function TagManager({ tags }: { tags: Row[] }) {
  if (tags.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-line px-4 py-10 text-center text-sm text-ink-muted">
        No tags yet. Open a client and use “+ Tag”, or select clients on the Clients page and use “Add tag”.
      </p>
    );
  }
  return (
    <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
      {tags.map((t) => (
        <TagRow key={t.id} tag={t} />
      ))}
    </ul>
  );
}

function TagRow({ tag }: { tag: Row }) {
  const router = useRouter();
  const [name, setName] = useState(tag.name);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function run(fn: () => Promise<void>) {
    setError(null);
    startTransition(async () => {
      try {
        await fn();
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "That didn't work.");
      }
    });
  }

  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-3">
      <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${tagClasses(tag.color)}`}>
        {tag.name}
      </span>
      <form
        className="flex items-center gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim() && name.trim() !== tag.name) run(() => updateTag(tag.id, { name }));
        }}
      >
        <input
          value={name}
          maxLength={MAX_TAG_LENGTH}
          onChange={(e) => setName(e.target.value)}
          aria-label={`Rename ${tag.name}`}
          className="w-40 rounded-md border border-line bg-surface px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-accent/40"
        />
        {name.trim() !== tag.name && name.trim() && (
          <button
            type="submit"
            disabled={isPending}
            className="rounded-md border border-line px-2 py-1 text-xs font-medium hover:bg-black/5 disabled:opacity-50"
          >
            Rename
          </button>
        )}
      </form>
      <div className="flex items-center gap-1" role="radiogroup" aria-label={`Colour for ${tag.name}`}>
        {TAG_COLOR_KEYS.map((c) => (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={tag.color === c}
            aria-label={c}
            title={c}
            disabled={isPending}
            onClick={() => tag.color !== c && run(() => updateTag(tag.id, { color: c }))}
            className={`h-5 w-5 rounded-full border ${tagClasses(c)} ${
              tag.color === c ? "ring-2 ring-accent ring-offset-1" : ""
            }`}
          />
        ))}
      </div>
      <Link href={`/clients?tag=${tag.id}`} className="text-xs text-ink-muted hover:text-accent">
        {tag.clients} client{tag.clients === 1 ? "" : "s"}
      </Link>
      <button
        type="button"
        disabled={isPending}
        onClick={() => {
          if (
            window.confirm(
              `Delete the tag “${tag.name}”? It will be removed from ${tag.clients} client${
                tag.clients === 1 ? "" : "s"
              }. The clients themselves are not affected.`
            )
          ) {
            run(() => deleteTag(tag.id));
          }
        }}
        className="ml-auto text-xs text-ink-muted hover:text-overdue disabled:opacity-50"
      >
        Delete
      </button>
      {error && <p className="w-full text-xs text-overdue">{error}</p>}
    </li>
  );
}
