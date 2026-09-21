"use client";

import { useState, useTransition } from "react";
import {
  createProjectSubTask,
  updateProjectSubTask,
  deleteProjectSubTask,
} from "@/lib/actions";

type SubTask = { id: string; name: string; note: string | null };

const inputClass =
  "rounded-md border border-line bg-surface px-3 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40";

function EditableRow({ task }: { task: SubTask }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(task.name);
  const [note, setNote] = useState(task.note ?? "");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function save() {
    setError(null);
    startTransition(async () => {
      try {
        await updateProjectSubTask(task.id, { name, note });
        setEditing(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't save.");
      }
    });
  }

  function remove() {
    if (!window.confirm(`Delete "${task.name}"?`)) return;
    setError(null);
    startTransition(async () => {
      try {
        await deleteProjectSubTask(task.id);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't delete.");
      }
    });
  }

  if (editing) {
    return (
      <tr className="border-b border-line last:border-0">
        <td className="px-4 py-2">
          <input value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
        </td>
        <td className="px-4 py-2">
          <input value={note} onChange={(e) => setNote(e.target.value)} className={inputClass} />
        </td>
        <td className="px-4 py-2 text-right">
          <div className="flex justify-end gap-3">
            <button onClick={save} disabled={isPending} className="text-xs text-accent hover:underline">
              Save
            </button>
            <button
              onClick={() => setEditing(false)}
              className="text-xs text-ink-muted hover:text-ink"
            >
              Cancel
            </button>
          </div>
          {error && <p className="mt-1 text-xs text-overdue">{error}</p>}
        </td>
      </tr>
    );
  }

  return (
    <tr className="border-b border-line last:border-0 hover:bg-black/[0.015]">
      <td className="px-4 py-2 text-ink">{task.name}</td>
      <td className="px-4 py-2 text-ink-muted">{task.note ?? "—"}</td>
      <td className="px-4 py-2 text-right">
        <div className="flex justify-end gap-3">
          <button onClick={() => setEditing(true)} className="text-xs text-accent hover:underline">
            Edit
          </button>
          <button
            onClick={remove}
            disabled={isPending}
            className="text-xs text-ink-muted hover:text-overdue disabled:opacity-50"
          >
            Delete
          </button>
        </div>
        {error && <p className="mt-1 text-xs text-overdue">{error}</p>}
      </td>
    </tr>
  );
}

export function ProjectSubTaskManager({ subtasks }: { subtasks: SubTask[] }) {
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      try {
        await createProjectSubTask({ name, note });
        setName("");
        setNote("");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't add task.");
      }
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <form
        onSubmit={handleCreate}
        className="flex flex-wrap items-end gap-3 rounded-lg border border-line bg-surface p-4"
      >
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs text-ink-muted">Task Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs text-ink-muted">Note</span>
          <input value={note} onChange={(e) => setNote(e.target.value)} className={inputClass} />
        </label>
        <button
          type="submit"
          disabled={isPending || !name.trim()}
          className="rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          Add Task
        </button>
        {error && <p className="w-full text-xs text-overdue">{error}</p>}
      </form>

      <div className="overflow-hidden rounded-lg border border-line bg-surface">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-line bg-black/[0.02] text-xs uppercase tracking-wide text-ink-muted">
              <th className="px-4 py-3 font-medium">Task Name</th>
              <th className="px-4 py-3 font-medium">Note</th>
              <th className="px-4 py-3 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {subtasks.map((t) => (
              <EditableRow key={t.id} task={t} />
            ))}
            {subtasks.length === 0 && (
              <tr>
                <td colSpan={3} className="px-4 py-10 text-center text-ink-muted">
                  No checklist steps defined yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
