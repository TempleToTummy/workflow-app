"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  addTaskComment,
  deleteTaskComment,
  editTaskComment,
} from "@/lib/comment-actions";
import { segmentBody, type MentionCandidate } from "@/lib/mentions";
import type { RootComment, Comment } from "@/lib/comment-data";
import { formatDate } from "@/lib/dates";

// The discussion under one checklist step.
//
// This replaces ClientActivity.notes as the place a conversation happens.
// `notes` is a single string: the second person to write destroys the first
// person's note, which is precisely the failure mode at a reviewer handoff,
// where two people write about the same task by definition. The old field is
// still there and still editable from the admin grid — it just isn't the
// discussion any more.
//
// Threading is one level: a root and its replies. Deeper nesting makes a
// handoff harder to read, not easier, and the server re-parents anything
// deeper onto its root (resolveParentId in src/lib/mentions.ts) so the data
// can never hold a shape this can't render.

const inputClass =
  "w-full rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40 disabled:opacity-50";

export function TaskDiscussion({
  activityId,
  comments,
  people,
  currentUserId,
  isAdmin,
}: {
  activityId: string;
  comments: RootComment[];
  people: MentionCandidate[];
  currentUserId: string;
  isAdmin: boolean;
}) {
  return (
    <div className="mt-3 border-t border-line pt-3">
      <p className="text-[11px] font-medium tracking-wide text-ink-muted uppercase">
        Discussion
      </p>

      <ul className="mt-2 flex flex-col gap-3">
        {comments.map((root) => (
          <li key={root.id}>
            <CommentBody
              comment={root}
              people={people}
              currentUserId={currentUserId}
              isAdmin={isAdmin}
            />
            {root.replies.length > 0 && (
              <ul className="mt-2 ml-4 flex flex-col gap-2 border-l border-line pl-3">
                {root.replies.map((reply) => (
                  <li key={reply.id}>
                    <CommentBody
                      comment={reply}
                      people={people}
                      currentUserId={currentUserId}
                      isAdmin={isAdmin}
                    />
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-1.5 ml-4">
              <Composer
                activityId={activityId}
                parentId={root.id}
                people={people}
                placeholder="Reply…"
                compact
              />
            </div>
          </li>
        ))}
        {comments.length === 0 && (
          <li className="text-xs text-ink-muted">
            No discussion yet. Type @ and a colleague&apos;s name to bring them in.
          </li>
        )}
      </ul>

      <div className="mt-3">
        <Composer activityId={activityId} parentId={null} people={people} />
      </div>
    </div>
  );
}

function CommentBody({
  comment,
  people,
  currentUserId,
  isAdmin,
}: {
  comment: Comment;
  people: MentionCandidate[];
  currentUserId: string;
  isAdmin: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.body);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [isPending, startTransition] = useTransition();

  const segments = useMemo(() => segmentBody(comment.body, people), [comment.body, people]);

  // Only the author may edit; an author or an admin may delete. Putting words
  // in somebody else's mouth in a record used for handoffs is a different
  // thing from removing a comment that shouldn't be there — the server
  // enforces the same split.
  const canEdit = comment.authorId === currentUserId;
  const canDelete = canEdit || isAdmin;
  // A comment with no author is the client answering through a request link.
  const fromClient = comment.authorId === null;

  return (
    <div className={fromClient ? "rounded-md border border-accent/30 bg-accent-soft px-2.5 py-2" : ""}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-ink">
          {comment.authorLabel}
          {comment.edited && (
            <span className="ml-1 font-normal text-ink-muted" title="This comment was edited">
              (edited)
            </span>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-2 text-[11px] text-ink-muted">
          <span>{formatDate(comment.createdAt)}</span>
          {canEdit && !editing && (
            <button type="button" onClick={() => setEditing(true)} className="hover:text-accent">
              Edit
            </button>
          )}
          {canDelete && (
            <button
              type="button"
              disabled={isPending}
              onClick={() => {
                if (!confirmDelete) {
                  setConfirmDelete(true);
                  return;
                }
                setError(null);
                startTransition(async () => {
                  try {
                    await deleteTaskComment(comment.id);
                    router.refresh();
                  } catch (err) {
                    setError(err instanceof Error ? err.message : "Couldn't remove that.");
                  }
                });
              }}
              onBlur={() => setConfirmDelete(false)}
              className={confirmDelete ? "font-medium text-overdue" : "hover:text-overdue"}
            >
              {confirmDelete ? "Sure?" : "×"}
            </button>
          )}
        </span>
      </div>

      {editing ? (
        <div className="mt-1">
          <textarea
            value={draft}
            rows={2}
            autoFocus
            disabled={isPending}
            onChange={(e) => setDraft(e.target.value)}
            className={inputClass}
          />
          <p className="mt-1 text-[11px] text-ink-muted">
            {/* Stated plainly, because the alternative is an author who thinks
                adding a name in an edit handed the task over. */}
            Editing doesn&apos;t notify anyone new — post a new comment to bring
            somebody in.
          </p>
          <div className="mt-1.5 flex gap-1.5">
            <button
              type="button"
              disabled={isPending || !draft.trim()}
              onClick={() => {
                setError(null);
                startTransition(async () => {
                  try {
                    await editTaskComment(comment.id, draft);
                    setEditing(false);
                    router.refresh();
                  } catch (err) {
                    setError(err instanceof Error ? err.message : "Couldn't save that.");
                  }
                });
              }}
              className="rounded-full bg-accent px-2.5 py-1 text-[11px] font-medium text-white disabled:opacity-50"
            >
              Save
            </button>
            <button
              type="button"
              onClick={() => {
                setDraft(comment.body);
                setEditing(false);
              }}
              className="rounded-full border border-line px-2.5 py-1 text-[11px] font-medium text-ink"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <p className="mt-0.5 text-sm whitespace-pre-wrap text-ink">
          {segments.map((seg, i) =>
            seg.mention ? (
              <span
                key={i}
                className="rounded bg-accent-soft px-1 font-medium text-accent"
              >
                {seg.text}
              </span>
            ) : (
              <span key={i}>{seg.text}</span>
            )
          )}
        </p>
      )}

      {error && <p className="mt-1 text-[11px] text-overdue">{error}</p>}
    </div>
  );
}

function Composer({
  activityId,
  parentId,
  people,
  placeholder = "Add a comment… use @ to mention someone",
  compact = false,
}: {
  activityId: string;
  parentId: string | null;
  people: MentionCandidate[];
  placeholder?: string;
  compact?: boolean;
}) {
  const router = useRouter();
  const [body, setBody] = useState("");
  const [open, setOpen] = useState(!compact);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function submit() {
    const trimmed = body.trim();
    if (!trimmed) return;
    setError(null);
    setNotice(null);
    startTransition(async () => {
      try {
        const result = await addTaskComment(activityId, { body: trimmed, parentId });
        setBody("");
        if (compact) setOpen(false);
        // Both halves matter. Confirming who was notified stops the author
        // wondering; naming what DIDN'T resolve is the important one, because
        // an @name that silently matched nobody leaves them believing they
        // handed the task over.
        const parts: string[] = [];
        if (result.mentioned.length > 0) parts.push(`Notified ${result.mentioned.join(", ")}.`);
        if (result.unresolved.length > 0) {
          parts.push(
            `${result.unresolved.join(", ")} didn't match anyone — use their full name.`
          );
        }
        setNotice(parts.join(" ") || null);
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't post that comment.");
      }
    });
  }

  if (compact && !open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-[11px] text-ink-muted hover:text-accent"
      >
        Reply
      </button>
    );
  }

  return (
    <div>
      <textarea
        value={body}
        rows={compact ? 2 : 2}
        disabled={isPending}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          // Enter is a newline; Cmd/Ctrl+Enter posts. A handoff note is often
          // more than one line, and losing a half-written one to a stray Enter
          // would be the most annoying possible bug here.
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submit();
          }
        }}
        placeholder={placeholder}
        className={inputClass}
      />
      <div className="mt-1.5 flex items-center gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={isPending || !body.trim()}
          className="rounded-full bg-accent px-3 py-1 text-[11px] font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {isPending ? "Posting…" : compact ? "Reply" : "Comment"}
        </button>
        {compact && (
          <button
            type="button"
            onClick={() => {
              setBody("");
              setOpen(false);
            }}
            className="text-[11px] text-ink-muted hover:text-ink"
          >
            Cancel
          </button>
        )}
        <span className="ml-auto text-[11px] text-ink-muted">
          {people.length > 0 && "@ to mention"}
        </span>
      </div>
      {notice && <p className="mt-1 text-[11px] text-ink-muted">{notice}</p>}
      {error && <p className="mt-1 text-[11px] text-overdue">{error}</p>}
    </div>
  );
}
