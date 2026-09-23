import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/auth";
import { canAccessEngagement } from "@/lib/access";

// Task-discussion reads. Not a "use server" module — these are queries for
// server components; the mutations are in src/lib/comment-actions.ts.

export type CommentTree = Awaited<ReturnType<typeof commentsForActivities>>;

// Every comment on a set of steps, as roots with their replies. One query for
// the lot rather than one per step: the assignment page shows a thread under
// each of nine checklist steps, and nine round trips per render would be the
// page's slowest part for no reason.
export async function commentsForActivities(activityIds: string[]) {
  if (activityIds.length === 0) return new Map<string, RootComment[]>();

  const rows = await prisma.taskComment.findMany({
    where: { activityId: { in: activityIds } },
    include: {
      author: { select: { id: true, firstName: true, lastName: true } },
      mentions: { select: { employeeId: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  const byActivity = new Map<string, RootComment[]>();
  const rootsById = new Map<string, RootComment>();

  // Roots first, then replies, so a reply can always find its parent
  // regardless of insertion order.
  for (const row of rows) {
    if (row.parentId) continue;
    const root: RootComment = { ...toComment(row), replies: [] };
    rootsById.set(row.id, root);
    const list = byActivity.get(row.activityId);
    if (list) list.push(root);
    else byActivity.set(row.activityId, [root]);
  }
  for (const row of rows) {
    if (!row.parentId) continue;
    // A reply whose root is missing can't happen (the FK cascades), but
    // dropping it silently would be worse than not rendering it, so it is
    // promoted to a root rather than discarded.
    const parent = rootsById.get(row.parentId);
    if (parent) {
      parent.replies.push(toComment(row));
    } else {
      const orphan: RootComment = { ...toComment(row), replies: [] };
      const list = byActivity.get(row.activityId);
      if (list) list.push(orphan);
      else byActivity.set(row.activityId, [orphan]);
    }
  }

  return byActivity;
}

type CommentRow = {
  id: string;
  activityId: string;
  parentId: string | null;
  authorId: string | null;
  authorLabel: string;
  body: string;
  editedAt: Date | null;
  createdAt: Date;
  mentions: { employeeId: string }[];
};

export type Comment = {
  id: string;
  authorId: string | null;
  authorLabel: string;
  body: string;
  edited: boolean;
  createdAt: string;
  mentionedIds: string[];
};

export type RootComment = Comment & { replies: Comment[] };

function toComment(row: CommentRow): Comment {
  return {
    id: row.id,
    authorId: row.authorId,
    authorLabel: row.authorLabel,
    body: row.body,
    edited: row.editedAt !== null,
    createdAt: row.createdAt.toISOString(),
    mentionedIds: row.mentions.map((m) => m.employeeId),
  };
}

// How many comments sit on each step, for the collapsed step header.
export async function commentCounts(activityIds: string[]): Promise<Map<string, number>> {
  if (activityIds.length === 0) return new Map();
  const rows = await prisma.taskComment.groupBy({
    by: ["activityId"],
    where: { activityId: { in: activityIds } },
    _count: { _all: true },
  });
  return new Map(rows.map((r) => [r.activityId, r._count._all]));
}

// --- Mentions -----------------------------------------------------------------

// Unread mentions for one person. This is the whole notification model: a
// mention row IS the notification, so there is no second table to keep in step
// with it.
export async function unreadMentionCount(employeeId: string): Promise<number> {
  return prisma.taskCommentMention.count({
    where: { employeeId, readAt: null },
  });
}

export async function listMentions(input: {
  employeeId: string;
  // "unread" is the default view; "all" is the archive, so a mention that was
  // read can still be found again.
  unreadOnly: boolean;
  take?: number;
}) {
  return prisma.taskCommentMention.findMany({
    where: {
      employeeId: input.employeeId,
      ...(input.unreadOnly ? { readAt: null } : {}),
    },
    include: {
      comment: {
        include: {
          activity: {
            include: {
              subTask: { select: { name: true } },
              client: { select: { id: true, companyName: true } },
              project: { select: { id: true, name: true } },
            },
          },
        },
      },
    },
    orderBy: { createdAt: "desc" },
    take: input.take ?? 100,
  });
}

// The people who can be @mentioned. Everyone in the firm, deliberately: a
// handoff often goes to somebody who is not yet on the engagement, and that is
// precisely the case where being able to pull them in matters. It leaks only
// the staff list, which every employee already sees in the assignee dropdown.
export async function mentionCandidates() {
  return prisma.employee.findMany({
    select: { id: true, firstName: true, lastName: true, email: true },
    orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
  });
}

// Whether an employee may see a given step's discussion, matching the
// engagement-level gate the assignment page already applies. The rule itself
// lives in src/lib/access.ts so reads and writes can't drift apart.
export async function canSeeActivity(user: CurrentUser, activityId: string): Promise<boolean> {
  const activity = await prisma.clientActivity.findUnique({
    where: { id: activityId },
    select: { clientId: true, projectId: true },
  });
  if (!activity) return false;
  return canAccessEngagement(user, activity.clientId, activity.projectId);
}
