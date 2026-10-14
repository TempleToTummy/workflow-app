"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  addAssignmentNote,
  addClientNote,
  deleteAssignmentNote,
  deleteClientNote,
  updateAssignmentNote,
  updateClientNote,
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

// Whose notes these are: one engagement (client + project), or the client as
// a whole. Same panel, same rules; only the actions differ.
type NoteScope =
  | { kind: "engagement"; clientId: string; projectId: string; instance: number }
  | { kind: "client"; clientId: string };

const ACTIONS = {
  engagement: { update: updateAssignmentNote, remove: deleteAssignmentNote },
  client: { update: updateClientNote, remove: deleteClientNote },
};

export function AssignmentNotes({
  clientId,
  projectId,
  instance = 1,
  notes,
}: {
  clientId: string;
  projectId: string;
  // Which copy of the project for this client (src/lib/engagements.ts).
  instance?: number;
  notes: NoteRow[];
}) {
  return <NotesPanel scope={{ kind: "engagement", clientId, projectId, instance }} notes={notes} />;
}

export function ClientNotes({ clientId, notes }: { clientId: string; notes: NoteRow[] }) {
  return (
    <NotesPanel
      scope={{ kind: "client", clientId }}
      notes={notes}
      title="Client notes"
      hint="Notes about this client as a whole — not one project or task."
      placeholder="Add a note about this client…"
    />
  );
}

function NotesPanel({
  scope,
  notes,
  title = "Notes",
  hint,
  placeholder = "Add a note about this engagement…",
}: {
  scope: NoteScope;
  notes: NoteRow[];
  title?: string;
  hint?: string;
  placeholder?: string;
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
        if (scope.kind === "engagement") {
          await addAssignmentNote(scope.clientId, scope.projectId, { body: trimmed }, scope.instance);
        } else {
          await addClientNote(scope.clientId, { body: trimmed });
        }
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
        {title}
        {notes.length > 0 && (
          <span className="count-pill ml-2 bg-black/5 align-middle normal-case tracking-normal">{notes.length}</span>
        )}
      </h2>
      {hint && <p className="mt-1 text-sm text-ink-muted">{hint}</p>}

      <div className="mt-4">
        <textarea
          value={body}
          rows={3}
          disabled={isPending}
          onChange={(e) => setBody(e.target.value)}
          placeholder={placeholder}
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
          <NoteItem key={note.id} note={note} actions={ACTIONS[scope.kind]} />
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

function NoteItem({
  note,
  actions,
}: {
  note: NoteRow;
  actions: (typeof ACTIONS)[keyof typeof ACTIONS];
}) {
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
        await actions.update(note.id, { body: trimmed });
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
        await actions.remove(note.id);
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
