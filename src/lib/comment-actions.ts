"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { recordAudit, actorFrom, AUDIT } from "@/lib/audit";
import {
  findMentions,
  resolveMentionedIds,
  resolveParentId,
  MAX_COMMENT_LENGTH,
} from "@/lib/mentions";
import { canSeeActivity } from "@/lib/comment-data";

// Task-discussion mutations.
//
// The gap this fills: ClientActivity.notes is a single string, so the second
// person to write on a task destroys the first person's note — and a handoff
// between two reviewer layers is exactly where two people write about the same
// task. AssignmentNote is engagement-level, with no threading and no way to
// direct a message at somebody.
//
// Three decisions worth knowing about:
//
//   1. Mentions are resolved once, at write time, against the employee list as
//      it is then, and stored as rows. src/lib/mentions.ts explains why: a
//      later rename must not change who a six-month-old comment notified, and
//      editing a body must not un-notify somebody already told.
//   2. Threading is one level. A reply to a reply is re-parented onto the root
//      by resolveParentId, so the data can never hold a chain the UI can't
//      render.
//   3. Editing keeps the comment and stamps editedAt. A discussion people rely
//      on for handoffs must not be quietly rewritable.

async function loadActivity(activityId: string) {
  return prisma.clientActivity.findUniqueOrThrow({
    where: { id: activityId },
    include: {
      subTask: { select: { name: true } },
      client: { select: { companyName: true } },
      project: { select: { name: true } },
    },
  });
}

function revalidateDiscussion(clientId: string, projectId: string) {
  revalidatePath("/");
  revalidatePath("/mentions");
  revalidatePath("/activity");
  revalidatePath(`/assignments/${clientId}/${projectId}`);
}

export type AddCommentResult = {
  id: string;
  // Who was notified, so the composer can confirm it rather than leaving the
  // author guessing whether "@Dana" found anybody.
  mentioned: string[];
  // Names typed with an @ that matched nobody, or matched ambiguously. Shown
  // as a warning: a mention that silently did nothing is the failure mode
  // worth surfacing, because the author believes they've handed the task over.
  unresolved: string[];
};

export async function addTaskComment(
  activityId: string,
  data: { body: string; parentId?: string | null }
): Promise<AddCommentResult> {
  const user = await requireUser();

  // The visibility gate the assignment page applies, repeated here because an
  // action is reachable by direct POST.
  if (!(await canSeeActivity(user, activityId))) {
    throw new Error("You don't have access to that task.");
  }

  const body = data.body.trim();
  if (!body) throw new Error("A comment can't be empty.");
  if (body.length > MAX_COMMENT_LENGTH) {
    throw new Error(`A comment has to be under ${MAX_COMMENT_LENGTH} characters.`);
  }

  const activity = await loadActivity(activityId);

  // Flatten a reply-to-a-reply onto its root, and refuse a parent from a
  // different task outright — that would put a comment in a thread its author
  // can't see from where they wrote it.
  let parentId: string | null = null;
  if (data.parentId) {
    const parent = await prisma.taskComment.findUnique({
      where: { id: data.parentId },
      select: { id: true, parentId: true, activityId: true },
    });
    if (!parent || parent.activityId !== activityId) {
      throw new Error("That comment is no longer there to reply to.");
    }
    parentId = resolveParentId(parent.id, parent.parentId);
  }

  const candidates = await prisma.employee.findMany({
    select: { id: true, firstName: true, lastName: true, email: true },
  });
  const mentionedIds = resolveMentionedIds(body, candidates, user.id);

  const authorLabel = `${user.firstName} ${user.lastName}`;
  const comment = await prisma.taskComment.create({
    data: {
      activityId,
      parentId,
      authorId: user.id,
      authorLabel,
      body,
      mentions: {
        create: mentionedIds.map((employeeId) => ({ employeeId })),
      },
    },
  });

  const nameById = new Map(candidates.map((c) => [c.id, `${c.firstName} ${c.lastName}`]));
  const mentioned = mentionedIds.map((id) => nameById.get(id) ?? "someone");

  await recordAudit({
    entityType: "ClientActivity",
    entityId: activityId,
    action: AUDIT.COMMENT_ADDED,
    summary: `${parentId ? "Replied on" : "Commented on"} ${activity.subTask.name}${
      mentioned.length > 0 ? ` — notified ${mentioned.join(", ")}` : ""
    }`,
    clientId: activity.clientId,
    projectId: activity.projectId,
    periodName: activity.periodName,
    contextLabel: `${activity.client.companyName} · ${activity.project.name}`,
    actor: actorFrom(user),
  });

  revalidateDiscussion(activity.clientId, activity.projectId);

  return {
    id: comment.id,
    mentioned,
    unresolved: unresolvedMentions(body, candidates),
  };
}

// The @names in a body that resolved to nobody. Computed by re-running the
// matcher and subtracting what resolved, so it uses exactly the same rules as
// the resolution itself rather than a second, drifting implementation.
function unresolvedMentions(
  body: string,
  candidates: { id: string; firstName: string; lastName: string; email: string }[]
): string[] {
  return [
    ...new Set(
      findMentions(body, candidates)
        .filter((m) => !m.employeeId)
        .map((m) => m.text)
    ),
  ];
}

export async function editTaskComment(commentId: string, body: string): Promise<void> {
  const user = await requireUser();
  const comment = await prisma.taskComment.findUniqueOrThrow({
    where: { id: commentId },
    select: { id: true, activityId: true, authorId: true, body: true },
  });

  // Only the author may edit. An admin can delete a comment (below) but not
  // rewrite one: putting words in somebody else's mouth in a record used for
  // handoffs is a different thing from removing a comment that shouldn't be
  // there, and only one of them has a legitimate use.
  if (comment.authorId !== user.id) {
    throw new Error("Only the author can edit a comment.");
  }

  const trimmed = body.trim();
  if (!trimmed) throw new Error("A comment can't be empty.");
  if (trimmed.length > MAX_COMMENT_LENGTH) {
    throw new Error(`A comment has to be under ${MAX_COMMENT_LENGTH} characters.`);
  }
  if (trimmed === comment.body) return;

  const activity = await loadActivity(comment.activityId);

  // Mentions are NOT recomputed. Somebody already notified stays notified —
  // the alternative lets an author quietly withdraw a handoff after the fact.
  // New names added in an edit don't notify either, which is the honest
  // trade: the composer tells the author to post a new comment for that.
  await prisma.taskComment.update({
    where: { id: commentId },
    data: { body: trimmed, editedAt: new Date() },
  });

  revalidateDiscussion(activity.clientId, activity.projectId);
}

export async function deleteTaskComment(commentId: string): Promise<void> {
  const user = await requireUser();
  const comment = await prisma.taskComment.findUniqueOrThrow({
    where: { id: commentId },
    include: { replies: { select: { id: true } } },
  });

  if (comment.authorId !== user.id && user.role !== "ADMIN") {
    throw new Error("Only the author or an admin can remove a comment.");
  }

  const activity = await loadActivity(comment.activityId);
  const replyCount = comment.replies.length;

  // Replies cascade with their root (see schema.prisma): a reply orphaned from
  // what it was answering reads as agreement with something invisible.
  await prisma.taskComment.delete({ where: { id: commentId } });

  await recordAudit({
    entityType: "ClientActivity",
    entityId: comment.activityId,
    action: AUDIT.COMMENT_DELETED,
    summary: `Removed a comment on ${activity.subTask.name}${
      replyCount > 0 ? ` and its ${replyCount} repl${replyCount === 1 ? "y" : "ies"}` : ""
    }`,
    fromValue: comment.body.slice(0, 200),
    clientId: activity.clientId,
    projectId: activity.projectId,
    periodName: activity.periodName,
    contextLabel: `${activity.client.companyName} · ${activity.project.name}`,
    actor: actorFrom(user),
  });

  revalidateDiscussion(activity.clientId, activity.projectId);
}

// --- Mentions -----------------------------------------------------------------

// Marks one mention read. Scoped to the caller's own rows in the WHERE clause
// rather than checked after the fact, so a guessed id updates nothing instead
// of updating somebody else's inbox.
export async function markMentionRead(mentionId: string): Promise<void> {
  const user = await requireUser();
  await prisma.taskCommentMention.updateMany({
    where: { id: mentionId, employeeId: user.id, readAt: null },
    data: { readAt: new Date() },
  });
  revalidatePath("/mentions");
}

export async function markAllMentionsRead(): Promise<number> {
  const user = await requireUser();
  const result = await prisma.taskCommentMention.updateMany({
    where: { employeeId: user.id, readAt: null },
    data: { readAt: new Date() },
  });
  revalidatePath("/mentions");
  return result.count;
}
