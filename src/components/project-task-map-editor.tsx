"use client";

import { useState, useTransition } from "react";
import { addProjectTaskMap, removeProjectTaskMap } from "@/lib/actions";

type Step = { subTaskId: string; name: string; sequence: number };
type SubTaskOption = { id: string; name: string };

const inputClass =
  "rounded-md border border-line bg-surface px-2 py-1 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40";

export function ProjectTaskMapEditor({
  projectId,
  projectName,
  steps,
  availableSubtasks,
}: {
  projectId: string;
  projectName: string;
  steps: Step[];
  availableSubtasks: SubTaskOption[];
}) {
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [subTaskId, setSubTaskId] = useState("");
  const [sequence, setSequence] = useState(
    String((steps[steps.length - 1]?.sequence ?? 0) + 10)
  );

  const usedIds = new Set(steps.map((s) => s.subTaskId));
  const choices = availableSubtasks.filter((t) => !usedIds.has(t.id));

  function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!subTaskId) return;
    startTransition(async () => {
      try {
        await addProjectTaskMap(projectId, subTaskId, Number(sequence) || 0);
        setSubTaskId("");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't add step.");
      }
    });
  }

  function handleRemove(id: string) {
    setError(null);
    startTransition(async () => {
      try {
        await removeProjectTaskMap(projectId, id);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't remove step.");
      }
    });
  }

  return (
    <div className="rounded-lg border border-line bg-surface p-5">
      <h2 className="mb-3 text-sm font-semibold text-ink">{projectName}</h2>
      <ol className="mb-3 flex flex-col gap-1.5">
        {steps.map((s) => (
          <li
            key={s.subTaskId}
            className="flex items-center justify-between gap-3 rounded-md bg-black/[0.02] px-3 py-1.5 text-sm"
          >
            <span className="text-ink-muted">
              <span className="tabular mr-2 text-xs text-ink-muted">{s.sequence}</span>
              {s.name}
            </span>
            <button
              onClick={() => handleRemove(s.subTaskId)}
              disabled={isPending}
              className="text-xs text-ink-muted hover:text-overdue disabled:opacity-50"
            >
              Remove
            </button>
          </li>
        ))}
        {steps.length === 0 && (
          <li className="rounded-md border border-dashed border-line px-3 py-4 text-center text-xs text-ink-muted">
            No checklist steps yet.
          </li>
        )}
      </ol>

      <form onSubmit={handleAdd} className="flex flex-wrap items-center gap-2">
        <select
          value={subTaskId}
          onChange={(e) => setSubTaskId(e.target.value)}
          className={inputClass}
        >
          <option value="">Add a task…</option>
          {choices.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <input
          type="number"
          value={sequence}
          onChange={(e) => setSequence(e.target.value)}
          className={`w-20 ${inputClass}`}
          aria-label="Sequence"
        />
        <button
          type="submit"
          disabled={isPending || !subTaskId}
          className="rounded-md border border-line px-3 py-1 text-sm text-ink hover:bg-black/5 disabled:opacity-50"
        >
          Add
        </button>
      </form>
      {error && <p className="mt-2 text-xs text-overdue">{error}</p>}
    </div>
  );
}
