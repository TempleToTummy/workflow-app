import type { ActivityStatus } from "@prisma/client";

type ActivityLike = { status: ActivityStatus; taskSeqNo: number };

// An assignment (one client working one project) doesn't have its own status,
// its progress is derived from the ordered task rows underneath it. This
// mirrors the sequential-completion rule from the source app: the "current"
// status is whatever the first not-done task is doing, and the assignment is
// only Done once every task in the current period is Done.
export function deriveAssignmentStatus(activities: ActivityLike[]): ActivityStatus {
  if (activities.length === 0) return "NOT_STARTED";
  const sorted = [...activities].sort((a, b) => a.taskSeqNo - b.taskSeqNo);
  if (sorted.every((a) => a.status === "DONE")) return "DONE";
  const firstIncomplete = sorted.find((a) => a.status !== "DONE");
  return firstIncomplete?.status ?? "NOT_STARTED";
}

export function progressLabel(activities: ActivityLike[]): string {
  const done = activities.filter((a) => a.status === "DONE").length;
  return `${done}/${activities.length}`;
}

// The original app enforced this with a trigger: a task can't be marked Done
// while an earlier task (lower taskSeqNo) in the same client/project/period
// is still open.
export function canMarkDone(
  target: ActivityLike,
  siblings: ActivityLike[]
): boolean {
  return siblings
    .filter((a) => a.taskSeqNo < target.taskSeqNo)
    .every((a) => a.status === "DONE");
}
