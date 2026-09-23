"use client";

import { useState, useTransition, useRef } from "react";
import { useRouter } from "next/navigation";
import { addClientTag, removeClientTag } from "@/lib/organize-actions";
import { tagClasses, sameTagName, MAX_TAG_LENGTH } from "@/lib/tags";

export type TagChip = { id: string; name: string; color: string };

export function TagPill({ tag, onRemove, disabled }: { tag: TagChip; onRemove?: () => void; disabled?: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${tagClasses(tag.color)}`}
    >
      {tag.name}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          disabled={disabled}
          aria-label={`Remove tag ${tag.name}`}
          className="-mr-0.5 rounded-full px-0.5 leading-none opacity-60 hover:opacity-100 disabled:opacity-30"
        >
          ×
        </button>
      )}
    </span>
  );
}

// Tags on a client, editable inline. Typing a name that already exists (in any
// case) attaches the existing tag; anything new is created on the spot.
export function ClientTagEditor({
  clientId,
  tags,
  allTags,
  canEdit,
}: {
  clientId: string;
  tags: TagChip[];
  allTags: TagChip[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  const suggestions = allTags
    .filter((t) => !tags.some((mine) => mine.id === t.id))
    .filter((t) => !text.trim() || t.name.toLowerCase().includes(text.trim().toLowerCase()))
    .slice(0, 8);
  const exact = allTags.find((t) => sameTagName(t.name, text));

  function add(name: string) {
    if (!name.trim()) return;
    setError(null);
    startTransition(async () => {
      try {
        await addClientTag(clientId, name);
        setText("");
        router.refresh();
        inputRef.current?.focus();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't add the tag.");
      }
    });
  }

  function remove(tagId: string) {
    setError(null);
    startTransition(async () => {
      try {
        await removeClientTag(clientId, tagId);
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't remove the tag.");
      }
    });
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-1.5">
        {tags.map((t) => (
          <TagPill key={t.id} tag={t} disabled={isPending} onRemove={canEdit ? () => remove(t.id) : undefined} />
        ))}
        {tags.length === 0 && !adding && <span className="text-xs text-ink-muted">No tags</span>}
        {canEdit && !adding && (
          <button
            type="button"
            onClick={() => {
              setAdding(true);
              setTimeout(() => inputRef.current?.focus(), 0);
            }}
            className="rounded-full border border-dashed border-line px-2 py-0.5 text-xs text-ink-muted hover:border-accent hover:text-accent"
          >
            + Tag
          </button>
        )}
      </div>

      {canEdit && adding && (
        <div className="relative mt-2 max-w-xs">
          <input
            ref={inputRef}
            value={text}
            maxLength={MAX_TAG_LENGTH}
            disabled={isPending}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add(text);
              } else if (e.key === "Escape") {
                setAdding(false);
                setText("");
              }
            }}
            placeholder="Type a tag and press Enter"
            aria-label="Add a tag"
            className="w-full rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent/40"
          />
          {(suggestions.length > 0 || (text.trim() && !exact)) && (
            <div className="absolute left-0 top-full z-20 mt-1 w-full rounded-md border border-line bg-surface p-1 shadow-lg">
              {suggestions.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => add(t.name)}
                  className="flex w-full items-center rounded px-2 py-1 text-left hover:bg-black/[0.03]"
                >
                  <TagPill tag={t} />
                </button>
              ))}
              {text.trim() && !exact && (
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => add(text)}
                  className="w-full rounded px-2 py-1 text-left text-xs text-ink-muted hover:bg-black/[0.03] hover:text-ink"
                >
                  Create tag “{text.trim()}”
                </button>
              )}
            </div>
          )}
          <button
            type="button"
            onClick={() => {
              setAdding(false);
              setText("");
            }}
            className="mt-1 text-xs text-ink-muted hover:text-ink"
          >
            Done
          </button>
        </div>
      )}
      {error && <p className="mt-1 text-xs text-overdue">{error}</p>}
    </div>
  );
}
