"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  addAssignmentNote,
  deleteAssignmentNote,
  updateAssignmentNote,
} from "@/lib/actions";
import { formatDate } from "@/lib/dates";

export type NoteRow = {
  id: string;
  body: string;
  authorName: string | null;
  createdAt: string;
  // Only the author (or an admin) may change a note; the server enforces it
  // and this just keeps the buttons away from people they'd fail for.
  canEdit: boolean;
};

const textareaClass =
  "w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40";

export function AssignmentNotes({
  clientId,
  projectId,
  notes,
}: {
  clientId: string;
  projectId: string;
  notes: NoteRow[];
}) {
  const router = useRouter();
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleAdd() {
    const trimmed = body.trim();
    if (!trimmed) return;
    setError(null);
    startTransition(async () => {
      try {
        await addAssignmentNote(clientId, projectId, { body: trimmed });
        setBody("");
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't add note.");
      }
    });
  }

  return (
    <div className="rounded-lg border border-line bg-surface p-6">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-muted">
        Notes
      </h2>

      <div className="mt-4">
        <textarea
          value={body}
          rows={3}
          disabled={isPending}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Add a note about this engagement…"
          className={textareaClass}
        />
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="text-xs text-ink-muted">Posted under your name.</span>
          <button
            type="button"
            onClick={handleAdd}
            disabled={isPending || !body.trim()}
            className="whitespace-nowrap rounded-full bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            Add note
          </button>
        </div>
        {error && <p className="mt-2 text-xs text-overdue">{error}</p>}
      </div>

      <ul className="mt-6 flex flex-col gap-4">
        {notes.map((note) => (
          <NoteItem key={note.id} note={note} />
        ))}
        {notes.length === 0 && (
          <li className="rounded-lg border border-dashed border-line px-4 py-8 text-center text-sm text-ink-muted">
            No notes yet.
          </li>
        )}
      </ul>
    </div>
  );
}

function NoteItem({ note }: { note: NoteRow }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note.body);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleSave() {
    const trimmed = draft.trim();
    if (!trimmed) return;
    setError(null);
    startTransition(async () => {
      try {
        await updateAssignmentNote(note.id, { body: trimmed });
        setEditing(false);
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't save.");
      }
    });
  }

  function handleDelete() {
    setError(null);
    startTransition(async () => {
      try {
        await deleteAssignmentNote(note.id);
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't delete.");
      }
    });
  }

  return (
    <li className="border-b border-line pb-4 last:border-0 last:pb-0">
      <div className="flex items-center justify-between gap-2 text-xs text-ink-muted">
        <span>
          {note.authorName ?? "—"} · {formatDate(note.createdAt)}
        </span>
        {note.canEdit && (
          <span className="flex items-center gap-2">
            {!editing && (
              <button
                type="button"
                onClick={() => {
                  setDraft(note.body);
                  setEditing(true);
                }}
                className="hover:text-accent"
              >
                Edit
              </button>
            )}
            <button
              type="button"
              onClick={handleDelete}
              disabled={isPending}
              aria-label="Delete note"
              className="hover:text-overdue disabled:opacity-50"
            >
              ×
            </button>
          </span>
        )}
      </div>

      {editing ? (
        <div className="mt-2">
          <textarea
            value={draft}
            rows={3}
            disabled={isPending}
            onChange={(e) => setDraft(e.target.value)}
            className={textareaClass}
          />
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={handleSave}
              disabled={isPending || !draft.trim()}
              className="whitespace-nowrap rounded-full bg-accent px-3 py-1 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              Save
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              disabled={isPending}
              className="rounded-full border border-line px-3 py-1 text-xs font-medium text-ink hover:bg-black/5"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <p className="mt-1.5 whitespace-pre-wrap text-sm text-ink">{note.body}</p>
      )}
      {error && <p className="mt-1.5 text-xs text-overdue">{error}</p>}
    </li>
  );
}
