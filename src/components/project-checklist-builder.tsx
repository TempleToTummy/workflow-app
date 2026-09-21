"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  addChecklistTask,
  removeChecklistTask,
  renameChecklistTask,
  reorderChecklist,
  setChecklistTaskDueOffset,
  setStepDefaultAssignee,
} from "@/lib/actions";
import { describeStepOffset, clampOffset } from "@/lib/due-dates";

export type ChecklistTask = {
  subTaskId: string;
  name: string;
  // Clients already have activity rows on this step — it can be reordered and
  // renamed, but not removed (the server enforces this too).
  inUse: boolean;
  // Internal milestone for this step, in days relative to the engagement's due
  // date. null = due with the project. Negative = earlier.
  dueOffsetDays: number | null;
  // Who normally does this step, across every client on this project. Wins
  // over the engagement's default owner — it expresses a role, not ownership.
  defaultAssigneeId: string | null;
};

export type BuilderEmployee = { id: string; name: string };

type DragState = {
  index: number; // where the dragged item started
  target: number; // where it would land if released now
  dy: number; // pointer travel since pointerdown, px
  height: number; // dragged item's height, px — how far neighbours shift
};

const inputClass =
  "rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40";

function moveItem<T>(list: T[], from: number, to: number): T[] {
  const next = [...list];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

// The project's checklist template, editable in place. Drag a task by its
// handle: as it crosses a neighbour's midpoint the neighbour slides out of the
// way (so dragging #3 up between #1 and #2 pushes #2 down into slot 3), and
// releasing commits the order. Arrow keys on the handle do the same thing.
export function ProjectChecklistBuilder({
  projectId,
  tasks,
  employees,
}: {
  projectId: string;
  tasks: ChecklistTask[];
  employees: BuilderEmployee[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Local order mirrors the server list so a drag can rearrange instantly;
  // it re-syncs whenever fresh props arrive (after router.refresh()).
  const [order, setOrder] = useState(tasks);
  const [syncedFrom, setSyncedFrom] = useState(tasks);
  if (tasks !== syncedFrom) {
    setSyncedFrom(tasks);
    setOrder(tasks);
  }

  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");

  const listRef = useRef<HTMLOListElement>(null);
  const dragRef = useRef<{ rects: DOMRect[]; startY: number } | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);

  const busy = isPending || drag !== null;

  function commitOrder(next: ChecklistTask[]) {
    setOrder(next);
    setError(null);
    startTransition(async () => {
      try {
        await reorderChecklist(
          projectId,
          next.map((t) => t.subTaskId)
        );
        router.refresh();
      } catch (err) {
        setOrder(tasks);
        setError(err instanceof Error ? err.message : "Couldn't save the new order.");
      }
    });
  }

  // --- drag -------------------------------------------------------------

  function onHandlePointerDown(e: React.PointerEvent<HTMLButtonElement>, index: number) {
    if (busy || e.button !== 0) return;
    const items = Array.from(
      listRef.current?.querySelectorAll<HTMLElement>("[data-task-row]") ?? []
    );
    const rects = items.map((el) => el.getBoundingClientRect());
    if (rects.length !== order.length) return;
    dragRef.current = { rects, startY: e.clientY };
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ index, target: index, dy: 0, height: rects[index].height });
    e.preventDefault();
  }

  function onHandlePointerMove(e: React.PointerEvent<HTMLButtonElement>) {
    const d = dragRef.current;
    if (!d || !drag) return;
    const { rects } = d;
    const i = drag.index;
    const mine = rects[i];
    // Keep the dragged row inside the list's vertical extent.
    const minDy = rects[0].top - mine.top;
    const maxDy = rects[rects.length - 1].bottom - mine.bottom;
    const dy = Math.max(minDy, Math.min(maxDy, e.clientY - d.startY));
    const center = mine.top + mine.height / 2 + dy;
    // The dragged row lands after every other row whose midpoint it has passed.
    let target = 0;
    rects.forEach((r, j) => {
      if (j !== i && r.top + r.height / 2 < center) target += 1;
    });
    setDrag({ index: i, target, dy, height: mine.height });
  }

  function onHandlePointerUp(e: React.PointerEvent<HTMLButtonElement>) {
    const current = drag;
    dragRef.current = null;
    setDrag(null);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    if (!current || current.target === current.index) return;
    commitOrder(moveItem(order, current.index, current.target));
  }

  function onHandleKeyDown(e: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    if (busy) return;
    const delta = e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0;
    if (!delta) return;
    e.preventDefault();
    const to = index + delta;
    if (to < 0 || to >= order.length) return;
    commitOrder(moveItem(order, index, to));
  }

  // While dragging, every non-dragged row gets a transform that slides it out
  // of (or back into) the way; the dragged row follows the pointer.
  function rowStyle(j: number): React.CSSProperties | undefined {
    if (!drag) return undefined;
    const { index: i, target, dy, height } = drag;
    if (j === i) {
      return { transform: `translateY(${dy}px)`, zIndex: 10, position: "relative" };
    }
    const shift =
      j < i && j >= target ? height : j > i && j <= target ? -height : 0;
    return {
      transform: `translateY(${shift}px)`,
      transition: "transform 160ms ease",
    };
  }

  // --- add / rename / remove --------------------------------------------

  function handleAdd() {
    const name = newName.trim();
    if (!name || busy) return;
    setNewName("");
    setError(null);
    startTransition(async () => {
      try {
        await addChecklistTask(projectId, name);
        router.refresh();
      } catch (err) {
        setNewName(name);
        setError(err instanceof Error ? err.message : "Couldn't add task.");
      }
    });
  }

  function startRename(task: ChecklistTask) {
    if (busy) return;
    setEditingId(task.subTaskId);
    setEditName(task.name);
  }

  function saveRename(task: ChecklistTask) {
    const name = editName.trim();
    setEditingId(null);
    if (!name || name === task.name) return;
    setError(null);
    startTransition(async () => {
      try {
        await renameChecklistTask(projectId, task.subTaskId, name);
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't rename task.");
      }
    });
  }

  function handleOffset(task: ChecklistTask, offset: number | null) {
    setError(null);
    startTransition(async () => {
      try {
        await setChecklistTaskDueOffset(projectId, task.subTaskId, offset);
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't save the step deadline.");
      }
    });
  }

  function handleDefaultAssignee(task: ChecklistTask, employeeId: string) {
    setError(null);
    startTransition(async () => {
      try {
        await setStepDefaultAssignee(projectId, task.subTaskId, employeeId || null);
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't set the default owner.");
      }
    });
  }

  function handleRemove(task: ChecklistTask) {
    if (busy) return;
    if (!window.confirm(`Remove "${task.name}" from this project's checklist?`)) return;
    setError(null);
    startTransition(async () => {
      try {
        await removeChecklistTask(projectId, task.subTaskId);
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't remove task.");
      }
    });
  }

  return (
    <div className="rounded-lg border border-line bg-surface shadow-sm">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-ink">Tasks</h2>
          <p className="text-xs text-ink-muted">
            Drag the handle to reorder. This order becomes the checklist for every client on
            this project. The owner and deadline on each step are applied when a new period
            is generated.
          </p>
        </div>
        <span className="tabular text-xs text-ink-muted">
          {order.length} {order.length === 1 ? "step" : "steps"}
        </span>
      </div>

      <ol ref={listRef} className="flex flex-col p-2">
        {order.map((task, j) => {
          const isDragging = drag?.index === j;
          const isEditing = editingId === task.subTaskId;
          return (
            <li
              key={task.subTaskId}
              data-task-row
              style={rowStyle(j)}
              className={`group flex items-center gap-2 rounded-md px-2 py-1.5 ${
                isDragging
                  ? "bg-surface shadow-lg ring-1 ring-accent/30"
                  : "hover:bg-black/[0.02]"
              }`}
            >
              <button
                type="button"
                aria-label={`Reorder "${task.name}". Drag, or use the arrow keys.`}
                disabled={isPending}
                onPointerDown={(e) => onHandlePointerDown(e, j)}
                onPointerMove={onHandlePointerMove}
                onPointerUp={onHandlePointerUp}
                onPointerCancel={onHandlePointerUp}
                onKeyDown={(e) => onHandleKeyDown(e, j)}
                className={`flex h-7 w-6 shrink-0 select-none items-center justify-center rounded text-ink-muted/60 hover:bg-black/5 hover:text-ink-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40 ${
                  isDragging ? "cursor-grabbing" : "cursor-grab"
                }`}
                style={{ touchAction: "none" }}
              >
                <svg viewBox="0 0 16 16" className="h-4 w-4" fill="currentColor" aria-hidden>
                  <circle cx="5.5" cy="3.5" r="1.3" />
                  <circle cx="10.5" cy="3.5" r="1.3" />
                  <circle cx="5.5" cy="8" r="1.3" />
                  <circle cx="10.5" cy="8" r="1.3" />
                  <circle cx="5.5" cy="12.5" r="1.3" />
                  <circle cx="10.5" cy="12.5" r="1.3" />
                </svg>
              </button>

              <span className="tabular flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-black/5 text-xs text-ink-muted">
                {j + 1}
              </span>

              {isEditing ? (
                <input
                  autoFocus
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  onBlur={() => saveRename(task)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      saveRename(task);
                    } else if (e.key === "Escape") {
                      setEditingId(null);
                    }
                  }}
                  className={`min-w-0 flex-1 ${inputClass}`}
                />
              ) : (
                <button
                  type="button"
                  onClick={() => startRename(task)}
                  title="Click to rename"
                  className="min-w-0 flex-1 truncate rounded px-1 py-1 text-left text-sm text-ink hover:bg-black/[0.03]"
                >
                  {task.name}
                </button>
              )}

              <select
                value={task.defaultAssigneeId ?? ""}
                disabled={busy}
                aria-label={`Default owner for "${task.name}"`}
                title="Who normally does this step. Applied when a new period is generated; overrides the engagement's default owner."
                onChange={(e) => handleDefaultAssignee(task, e.target.value)}
                className={`w-32 shrink-0 rounded-md border px-1.5 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-accent/40 disabled:opacity-40 ${
                  task.defaultAssigneeId
                    ? "border-line bg-surface text-ink"
                    : "border-transparent bg-transparent text-ink-muted/60 hover:border-line"
                }`}
              >
                <option value="">Anyone</option>
                {employees.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </select>

              <StepOffset
                task={task}
                disabled={busy}
                onSave={(offset) => handleOffset(task, offset)}
              />

              {task.inUse ? (
                <span
                  title="Clients already have activity on this step, so it can't be removed."
                  className="shrink-0 rounded-full bg-black/5 px-1.5 py-0.5 text-[10px] font-medium text-ink-muted"
                >
                  In use
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => handleRemove(task)}
                  disabled={busy}
                  aria-label={`Remove "${task.name}"`}
                  className="shrink-0 rounded px-1.5 text-base leading-none text-ink-muted opacity-0 transition-opacity hover:text-overdue focus:opacity-100 group-hover:opacity-100 disabled:opacity-0"
                >
                  ×
                </button>
              )}
            </li>
          );
        })}
        {order.length === 0 && (
          <li className="rounded-md border border-dashed border-line px-3 py-8 text-center text-sm text-ink-muted">
            No tasks yet. Add the first step below.
          </li>
        )}
      </ol>

      <div className="flex items-center gap-2 border-t border-line px-4 py-3">
        <input
          value={newName}
          disabled={isPending}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              handleAdd();
            }
          }}
          placeholder="Add a task and press Enter…"
          className={`min-w-0 flex-1 ${inputClass}`}
        />
        <button
          type="button"
          onClick={handleAdd}
          disabled={busy || !newName.trim()}
          className="shrink-0 rounded-full bg-accent px-4 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {isPending ? "Saving…" : "Add task"}
        </button>
      </div>
      {error && <p className="px-4 pb-3 text-xs text-overdue">{error}</p>}
    </div>
  );
}

// Per-step deadline, relative to the engagement's due date. Most steps have
// none and simply share the project's date; this is for the ones that need an
// internal milestone ("reviewer layer 2 done a week before we file").
function StepOffset({
  task,
  disabled,
  onSave,
}: {
  task: ChecklistTask;
  disabled: boolean;
  onSave: (offset: number | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(
    task.dueOffsetDays === null ? "" : String(task.dueOffsetDays)
  );

  function commit() {
    setEditing(false);
    const text = value.trim();
    const next = text === "" ? null : clampOffset(Number(text));
    if (text !== "" && !Number.isFinite(Number(text))) return;
    if (next === task.dueOffsetDays) return;
    onSave(next);
  }

  if (editing) {
    return (
      <input
        autoFocus
        type="number"
        inputMode="numeric"
        value={value}
        placeholder="0"
        aria-label={`Days relative to the project due date for "${task.name}". Blank means due with the project.`}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            setValue(task.dueOffsetDays === null ? "" : String(task.dueOffsetDays));
            setEditing(false);
          }
        }}
        className="tabular w-20 shrink-0 rounded-md border border-line bg-surface px-1.5 py-1 text-xs text-ink focus:outline-none focus:ring-2 focus:ring-accent/40"
      />
    );
  }

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => {
        setValue(task.dueOffsetDays === null ? "" : String(task.dueOffsetDays));
        setEditing(true);
      }}
      title="Set this step's deadline relative to the project's due date. Negative is earlier; blank shares the project's date."
      className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] transition-colors disabled:opacity-40 ${
        task.dueOffsetDays === null
          ? "border-transparent text-ink-muted/60 opacity-0 group-hover:opacity-100 hover:border-line hover:text-ink-muted focus:opacity-100"
          : "border-line text-ink-muted hover:text-ink"
      }`}
    >
      {describeStepOffset(task.dueOffsetDays)}
    </button>
  );
}
