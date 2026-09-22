// Workload and capacity. Pure, no next/* or Prisma import, so
// scripts/test-workload.ts can exercise the bucketing and the load maths
// directly.
//
// The gap this closes: the app could assign work but showed nothing about how
// much anyone was already carrying, so every assignment decision was made
// blind. What makes the answer honest rather than merely numeric:
//
//   - Open tasks and committed hours are different questions. Twelve tasks
//     with no estimates is not "0 hours", it's twelve tasks of unknown size,
//     and the view reports the unknown rather than implying an empty plate.
//     `unestimatedCount` exists for exactly that.
//   - Overdue work is counted separately, not folded into a total. Somebody
//     carrying forty hours of which thirty are already late is in a different
//     situation from somebody carrying forty hours due next month.
//   - Capacity is a comparison, never a gate. Nothing in the app refuses an
//     assignment for exceeding it.

import { dueBucket, type DueBucket } from "@/lib/dates";

export type WorkloadTask = {
  status: string;
  dueDate: Date | null;
  estimatedMinutes: number | null;
};

export type WorkloadBuckets = {
  overdue: number;
  today: number;
  thisWeek: number;
  nextWeek: number;
  later: number;
  noDueDate: number;
};

export type WorkloadSummary = {
  // Every task that is not DONE. This is the "how many" answer.
  openCount: number;
  // Sum of the estimates that exist, in minutes. This is the "how many hours"
  // answer, and it is only as complete as `estimatedCount` says it is.
  committedMinutes: number;
  estimatedCount: number;
  // Open tasks with no estimate. Reported, never treated as zero.
  unestimatedCount: number;
  // Open work already past its due date, by count and by estimated minutes.
  overdueCount: number;
  overdueMinutes: number;
  buckets: WorkloadBuckets;
};

const EMPTY_BUCKETS: WorkloadBuckets = {
  overdue: 0,
  today: 0,
  thisWeek: 0,
  nextWeek: 0,
  later: 0,
  noDueDate: 0,
};

// dueBucket() returns "none" both for work that is DONE and for work with no
// due date; here only the second case can occur, since DONE rows are filtered
// out before bucketing. Keeping the mapping explicit means a change to
// dueBucket can't silently reclassify an open task as finished.
function bucketKey(bucket: DueBucket): keyof WorkloadBuckets {
  switch (bucket) {
    case "overdue":
      return "overdue";
    case "today":
      return "today";
    case "this-week":
      return "thisWeek";
    case "next-week":
      return "nextWeek";
    case "later":
      return "later";
    case "none":
      return "noDueDate";
  }
}

export function summarizeWorkload(
  tasks: WorkloadTask[],
  now: Date = new Date()
): WorkloadSummary {
  const buckets: WorkloadBuckets = { ...EMPTY_BUCKETS };
  let openCount = 0;
  let committedMinutes = 0;
  let estimatedCount = 0;
  let unestimatedCount = 0;
  let overdueCount = 0;
  let overdueMinutes = 0;

  for (const task of tasks) {
    if (task.status === "DONE") continue;
    openCount += 1;

    const minutes = task.estimatedMinutes ?? null;
    if (minutes !== null && minutes > 0) {
      committedMinutes += minutes;
      estimatedCount += 1;
    } else {
      unestimatedCount += 1;
    }

    const bucket = dueBucket(task.dueDate, task.status, now);
    buckets[bucketKey(bucket)] += 1;
    if (bucket === "overdue") {
      overdueCount += 1;
      overdueMinutes += minutes ?? 0;
    }
  }

  return {
    openCount,
    committedMinutes,
    estimatedCount,
    unestimatedCount,
    overdueCount,
    overdueMinutes,
    buckets,
  };
}

export type LoadLevel = "unknown" | "light" | "steady" | "full" | "over";

export type Load = {
  level: LoadLevel;
  // Percentage of the week's capacity committed. Null when capacity isn't set,
  // or when nothing carried an estimate — a bar drawn from no data would be a
  // fabrication.
  percent: number | null;
};

// Committed hours against a weekly capacity. The thresholds are the obvious
// ones and are only used for colour; the number itself is always shown, so a
// reader is never left interpreting a band.
//
// A percentage is withheld in two cases, and they are different: no capacity
// on file (nothing to compare against) and no estimates on file (nothing to
// compare). Both return null, and the caller says which.
export function computeLoad(input: {
  committedMinutes: number;
  weeklyCapacityMinutes: number | null;
  estimatedCount: number;
}): Load {
  if (!input.weeklyCapacityMinutes || input.weeklyCapacityMinutes <= 0) {
    return { level: "unknown", percent: null };
  }
  if (input.estimatedCount === 0) {
    return { level: "unknown", percent: null };
  }
  const percent = Math.round((input.committedMinutes / input.weeklyCapacityMinutes) * 100);
  const level: LoadLevel =
    percent > 100 ? "over" : percent >= 85 ? "full" : percent >= 40 ? "steady" : "light";
  return { level, percent };
}

// Who to hand the next task to. Sorted by committed minutes ascending, but
// anybody with unknown load sorts last rather than first: an empty-looking
// plate that is empty only because nothing was estimated is not evidence of
// spare capacity, and putting them at the top would recommend the person the
// app knows least about.
export function suggestAssignee<T extends { load: Load; summary: WorkloadSummary }>(
  people: T[]
): T | null {
  const ranked = [...people].sort((a, b) => {
    const aKnown = a.load.percent !== null;
    const bKnown = b.load.percent !== null;
    if (aKnown !== bKnown) return aKnown ? -1 : 1;
    if (aKnown && bKnown) return a.load.percent! - b.load.percent!;
    return a.summary.openCount - b.summary.openCount;
  });
  return ranked[0] ?? null;
}

export const LOAD_LABELS: Record<LoadLevel, string> = {
  unknown: "No estimate",
  light: "Light",
  steady: "Steady",
  full: "Nearly full",
  over: "Over capacity",
};

// Common capacity presets, in minutes, for the employee form. A firm's
// standard week, plus the part-time fractions of it.
export const CAPACITY_PRESETS: { label: string; minutes: number }[] = [
  { label: "40 h / week", minutes: 40 * 60 },
  { label: "37.5 h / week", minutes: Math.round(37.5 * 60) },
  { label: "32 h / week (0.8)", minutes: 32 * 60 },
  { label: "24 h / week (0.6)", minutes: 24 * 60 },
  { label: "20 h / week (0.5)", minutes: 20 * 60 },
];
