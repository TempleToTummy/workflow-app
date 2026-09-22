"use client";

import { useOptimistic, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { ActivityStatus, SubtaskKind } from "@prisma/client";
import { StatusSelect } from "@/components/status-select";
import {
  addActivitySubtask,
  deleteActivitySubtask,
  setActivityAssignee,
  setActivityDueDate,
  setActivityEstimate,
  toggleActivitySubtask,
} from "@/lib/actions";
import { formatDueDate, dueDateUrgency } from "@/lib/dates";
import { formatMinutes, parseDuration } from "@/lib/time";
import { TaskTimer } from "@/components/task-timer";
import { TaskDiscussion } from "@/components/task-discussion";
import type { RootComment } from "@/lib/comment-data";
import type { MentionCandidate } from "@/lib/mentions";

export type ChecklistSubtask = {
  id: string;
  name: string;
  kind: SubtaskKind;
  done: boolean;
};

export type ChecklistStep = {
  id: string;
  seq: number;
  name: string;
  status: ActivityStatus;
  assigneeId: string | null;
  // Resolved from the due-date rules when the row was generated, or typed in
  // by hand (then `dueOverridden` is set and rule changes leave it alone).
  // ISO yyyy-mm-dd so it drops straight into a date input.
  dueDate: string | null;
  dueOverridden: boolean;
  // Who signed this step off and when, straight from the row rather than
  // inferred from updatedAt. Null until it's done; cleared if it's re-opened.
  completedBy: string | null;
  completedAt: string | null;
  subtasks: ChecklistSubtask[];
  // How long this step is expected to take, seeded from the project's step
  // template and then editable per task. Minutes; null = unknown, which the
  // workload view reports as unknown rather than as zero.
  estimatedMinutes: number | null;
  // Minutes already booked against this step by anyone.
  loggedMinutes: number;
  // ISO start time when the viewer's running timer is on THIS step, else null.
  timerSince: string | null;
  // The step's discussion thread (roots with their replies).
  comments: RootComment[];
  // Open client requests hanging off this step, so the row says the work is
  // blocked on somebody outside the firm rather than looking merely untouched.
  openRequests: number;
};

type Employee = { id: string; name: string };

const selectClass =
  "rounded-md border border-line bg-surface px-2 py-1 text-sm text-ink disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-accent/40";

export function AssignmentChecklist({
  steps,
  employees,
  people,
  currentUserId,
  isAdmin,
  // True when a timer is running on some other task, so each step's button can
  // say what pressing it will do.
  timerRunningElsewhere,
}: {
  steps: ChecklistStep[];
  employees: Employee[];
  people: MentionCandidate[];
  currentUserId: string;
  isAdmin: boolean;
  timerRunningElsewhere: boolean;
}) {
  if (steps.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-line px-4 py-10 text-center text-sm text-ink-muted">
        No tasks generated for the current period yet.
      </div>
    );
  }

  return (
    <ol className="flex flex-col gap-2">
      {steps.map((step, i) => (
        <StepRow
          key={step.id}
          step={step}
          index={i}
          employees={employees}
          people={people}
          currentUserId={currentUserId}
          isAdmin={isAdmin}
          timerRunningElsewhere={timerRunningElsewhere}
        />
      ))}
    </ol>
  );
}

type SubtaskAction =
  | { type: "add"; sub: ChecklistSubtask }
  | { type: "toggle"; id: string; done: boolean }
  | { type: "delete"; id: string };

function StepRow({
  step,
  index,
  employees,
  people,
  currentUserId,
  isAdmin,
  timerRunningElsewhere,
}: {
  step: ChecklistStep;
  index: number;
  employees: Employee[];
  people: MentionCandidate[];
  currentUserId: string;
  isAdmin: boolean;
  timerRunningElsewhere: boolean;
}) {
  const router = useRouter();
  // Open a step that already has something to show — subtasks or a
  // conversation — so a handoff note isn't hidden behind a disclosure
  // triangle nobody thinks to click.
  const [expanded, setExpanded] = useState(
    step.subtasks.length > 0 || step.comments.length > 0
  );
  const [newName, setNewName] = useState("");
  const [newKind, setNewKind] = useState<SubtaskKind>("TEAM_TASK");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // Optimistic views derived from props. After each action we call
  // router.refresh(), so props catch up and the optimistic layer resets to
  // match — no stale mirror state, no refresh needed to see the change.
  const [subtasks, applySubtask] = useOptimistic(
    step.subtasks,
    (state: ChecklistSubtask[], action: SubtaskAction) => {
      switch (action.type) {
        case "add":
          return [...state, action.sub];
        case "toggle":
          return state.map((s) => (s.id === action.id ? { ...s, done: action.done } : s));
        case "delete":
          return state.filter((s) => s.id !== action.id);
      }
    }
  );
  const [assignee, setOptimisticAssignee] = useOptimistic(step.assigneeId ?? "");

  const doneCount = subtasks.filter((s) => s.done).length;

  function handleAdd() {
    const name = newName.trim();
    if (!name) return;
    const kind = newKind;
    setNewName("");
    setError(null);
    startTransition(async () => {
      applySubtask({
        type: "add",
        sub: { id: `pending-${crypto.randomUUID()}`, name, kind, done: false },
      });
      try {
        await addActivitySubtask(step.id, { name, kind });
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't add subtask.");
      }
    });
  }

  function handleToggle(sub: ChecklistSubtask) {
    setError(null);
    startTransition(async () => {
      applySubtask({ type: "toggle", id: sub.id, done: !sub.done });
      try {
        await toggleActivitySubtask(sub.id, !sub.done);
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't update subtask.");
      }
    });
  }

  function handleDelete(id: string) {
    setError(null);
    startTransition(async () => {
      applySubtask({ type: "delete", id });
      try {
        await deleteActivitySubtask(id);
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't delete subtask.");
      }
    });
  }

  function handleAssignee(value: string) {
    setError(null);
    startTransition(async () => {
      setOptimisticAssignee(value);
      try {
        await setActivityAssignee(step.id, value);
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't change assignee.");
      }
    });
  }

  return (
    <li className="rounded-lg border border-line bg-surface">
      <div className="flex items-center justify-between gap-4 px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-label={expanded ? "Collapse" : "Expand"}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-ink-muted hover:bg-black/5"
          >
            <svg
              viewBox="0 0 20 20"
              className={`h-3.5 w-3.5 transition-transform ${expanded ? "rotate-90" : ""}`}
              fill="currentColor"
            >
              <path d="M7 5l6 5-6 5z" />
            </svg>
          </button>
          <span className="tabular flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-black/5 text-xs text-ink-muted">
            {index + 1}
          </span>
          <div className="min-w-0">
            <p className="truncate font-medium text-ink">{step.name}</p>
            {step.completedBy && step.completedAt && (
              <p className="text-[11px] text-ink-muted">
                Signed off by {step.completedBy} · {step.completedAt}
              </p>
            )}
            <p className="tabular flex flex-wrap items-center gap-x-2 text-[11px] text-ink-muted">
              {subtasks.length > 0 && (
                <span>
                  {doneCount}/{subtasks.length} subtasks
                </span>
              )}
              {step.comments.length > 0 && (
                <span>
                  {step.comments.length +
                    step.comments.reduce((n, c) => n + c.replies.length, 0)}{" "}
                  comments
                </span>
              )}
              {step.openRequests > 0 && (
                <span className="font-medium text-[var(--status-review)]">
                  waiting on client
                </span>
              )}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <TaskTimer
            activityId={step.id}
            runningSince={step.timerSince}
            loggedMinutes={step.loggedMinutes}
            otherRunning={timerRunningElsewhere}
            disabled={isPending}
          />
          <StepEstimate step={step} disabled={isPending} onError={setError} />
          <StepDueDate step={step} disabled={isPending} onError={setError} />
          <select
            value={assignee}
            disabled={isPending}
            onChange={(e) => handleAssignee(e.target.value)}
            className={selectClass}
          >
            <option value="">Unassigned</option>
            {employees.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
          <StatusSelect activityId={step.id} status={step.status} />
        </div>
      </div>

      {expanded && (
        <div className="border-t border-line px-4 py-3 pl-13">
          <ul className="flex flex-col gap-1.5">
            {subtasks.map((sub) => (
              <li key={sub.id} className="group flex items-center gap-2.5 text-sm">
                <input
                  type="checkbox"
                  checked={sub.done}
                  disabled={isPending || sub.id.startsWith("pending-")}
                  onChange={() => handleToggle(sub)}
                  className="h-4 w-4 shrink-0 accent-[var(--accent)]"
                />
                <span
                  className={`min-w-0 flex-1 truncate ${
                    sub.done ? "text-ink-muted line-through" : "text-ink"
                  }`}
                >
                  {sub.name}
                </span>
                {sub.kind === "CLIENT_TASK" && (
                  <span className="shrink-0 rounded-full bg-[var(--status-review-soft)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--status-review)]">
                    Client
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => handleDelete(sub.id)}
                  disabled={isPending || sub.id.startsWith("pending-")}
                  aria-label="Delete subtask"
                  className="shrink-0 text-ink-muted opacity-0 transition-opacity hover:text-overdue group-hover:opacity-100"
                >
                  ×
                </button>
              </li>
            ))}
            {subtasks.length === 0 && (
              <li className="text-xs text-ink-muted">No subtasks yet.</li>
            )}
          </ul>

          <div className="mt-2.5 flex items-center gap-2">
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
              placeholder={
                newKind === "CLIENT_TASK" ? "Request from client…" : "Add subtask…"
              }
              className="min-w-0 flex-1 rounded-md border border-line bg-surface px-2 py-1 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40"
            />
            <select
              value={newKind}
              disabled={isPending}
              onChange={(e) => setNewKind(e.target.value as SubtaskKind)}
              className={selectClass}
            >
              <option value="TEAM_TASK">Team</option>
              <option value="CLIENT_TASK">Client</option>
            </select>
            <button
              type="button"
              onClick={handleAdd}
              disabled={isPending || !newName.trim()}
              className="shrink-0 rounded-full border border-line px-3 py-1 text-xs font-medium text-ink hover:bg-black/5 disabled:opacity-50"
            >
              Add
            </button>
          </div>
          {error && <p className="mt-1.5 text-xs text-overdue">{error}</p>}

          <TaskDiscussion
            activityId={step.id}
            comments={step.comments}
            people={people}
            currentUserId={currentUserId}
            isAdmin={isAdmin}
          />
        </div>
      )}
    </li>
  );
}

// The step's time estimate, click to edit. Takes the same flexible input as
// the time fields elsewhere ("45", "1:30", "1.5h" — see parseDuration in
// src/lib/time.ts), so there is one duration grammar in the app rather than
// one per form.
//
// Editing here changes THIS task only. The template's estimate lives on the
// project's checklist and seeds new rows; correcting it here is the common
// case ("Bluepoint's data entry always takes three times as long"), which is
// exactly why a template change is not retroactive.
function StepEstimate({
  step,
  disabled,
  onError,
}: {
  step: ChecklistStep;
  disabled: boolean;
  onError: (message: string | null) => void;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(
    step.estimatedMinutes === null ? "" : String(step.estimatedMinutes)
  );
  const [isPending, startTransition] = useTransition();

  function save(raw: string) {
    setEditing(false);
    const trimmed = raw.trim();
    const minutes = trimmed === "" ? null : parseDuration(trimmed);
    if (trimmed !== "" && minutes === null) {
      onError("Enter an estimate like 45, 1:30 or 1.5h.");
      return;
    }
    if (minutes === step.estimatedMinutes) return;
    onError(null);
    startTransition(async () => {
      try {
        await setActivityEstimate(step.id, minutes);
        router.refresh();
      } catch (err) {
        onError(err instanceof Error ? err.message : "Couldn't set the estimate.");
      }
    });
  }

  if (editing) {
    return (
      <input
        autoFocus
        defaultValue={draft}
        disabled={isPending}
        onBlur={(e) => save(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            save((e.target as HTMLInputElement).value);
          } else if (e.key === "Escape") {
            setEditing(false);
          }
        }}
        placeholder="1h 30m"
        aria-label="Estimate"
        className="tabular w-20 rounded-md border border-line bg-surface px-2 py-1 text-xs text-ink focus:ring-2 focus:ring-accent/40 focus:outline-none"
      />
    );
  }

  return (
    <button
      type="button"
      disabled={disabled || isPending}
      onClick={() => {
        setDraft(step.estimatedMinutes === null ? "" : String(step.estimatedMinutes));
        setEditing(true);
      }}
      title={
        step.estimatedMinutes === null
          ? "No estimate. Click to add one — this is what the workload view counts as hours."
          : "Estimated time for this step. Click to change."
      }
      className="tabular shrink-0 rounded-md border border-transparent px-2 py-1 text-xs text-ink-muted hover:border-line disabled:opacity-50"
    >
      {step.estimatedMinutes === null ? "est." : `~${formatMinutes(step.estimatedMinutes)}`}
    </button>
  );
}

// One step's deadline. Shows the date the rules produced; clicking opens a
// date input that pins it by hand (and marks it overridden so a later change
// to the service's rule won't move it back). Clearing hands the step back to
// the rules.
function StepDueDate({
  step,
  disabled,
  onError,
}: {
  step: ChecklistStep;
  disabled: boolean;
  onError: (message: string | null) => void;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [isPending, startTransition] = useTransition();

  const due = step.dueDate ? new Date(`${step.dueDate}T00:00:00`) : null;
  const urgency = dueDateUrgency(due, step.status);

  function save(next: string | null) {
    setEditing(false);
    if ((next ?? "") === (step.dueDate ?? "")) return;
    onError(null);
    startTransition(async () => {
      try {
        await setActivityDueDate(step.id, next);
        router.refresh();
      } catch (err) {
        onError(err instanceof Error ? err.message : "Couldn't set the due date.");
      }
    });
  }

  if (editing) {
    return (
      <span className="flex items-center gap-1">
        <input
          autoFocus
          type="date"
          defaultValue={step.dueDate ?? ""}
          disabled={isPending}
          onBlur={(e) => save(e.target.value || null)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              save((e.target as HTMLInputElement).value || null);
            } else if (e.key === "Escape") {
              setEditing(false);
            }
          }}
          className="tabular rounded-md border border-line bg-surface px-2 py-1 text-xs text-ink focus:outline-none focus:ring-2 focus:ring-accent/40"
        />
        {step.dueOverridden && (
          <button
            type="button"
            onClick={() => save(null)}
            title="Clear the manual date and follow the service's due-date rule again"
            className="rounded px-1 text-xs text-ink-muted hover:text-ink"
          >
            reset
          </button>
        )}
      </span>
    );
  }

  return (
    <button
      type="button"
      disabled={disabled || isPending}
      onClick={() => setEditing(true)}
      title={
        step.dueOverridden
          ? "Set by hand. The service's due-date rule won't change it."
          : "From the service's due-date rule. Click to set a date by hand."
      }
      className={`tabular shrink-0 rounded-md border border-transparent px-2 py-1 text-xs hover:border-line disabled:opacity-50 ${
        step.status === "DONE"
          ? "text-ink-muted"
          : urgency === "overdue"
          ? "font-medium text-overdue"
          : urgency === "soon"
          ? "font-medium text-[var(--status-review)]"
          : "text-ink-muted"
      }`}
    >
      {formatDueDate(due)}
      {step.dueOverridden && <span className="ml-0.5 opacity-60">*</span>}
    </button>
  );
}
