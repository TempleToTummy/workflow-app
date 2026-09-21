export function formatDueDate(date: Date | null): string {
  if (!date) return "No due date";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
  }).format(date);
}

// e.g. "Sep 7, 2026" — used where a full date (not just month/day) matters,
// like note timestamps and file upload dates.
export function formatDate(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(d);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

// Which "due" bucket an assignment falls in, for the dashboard summary cards
// and their ?due= filter. Weeks run Monday–Sunday. Done work and work with no
// due date fall outside every bucket. "today" is also inside "this-week"; the
// caller decides whether to count it in both (the cards do, like FinancialCents).
export type DueBucket = "overdue" | "today" | "this-week" | "next-week" | "later" | "none";

export function dueBucket(date: Date | null, status: string, now: Date = new Date()): DueBucket {
  if (!date || status === "DONE") return "none";
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const due = new Date(date);
  due.setHours(0, 0, 0, 0);
  const diffDays = Math.round((due.getTime() - today.getTime()) / 86_400_000);
  if (diffDays < 0) return "overdue";
  if (diffDays === 0) return "today";
  // Days remaining in the current Mon–Sun week after today (Sunday → 0).
  const dow = today.getDay(); // 0 = Sunday
  const daysLeftThisWeek = dow === 0 ? 0 : 7 - dow;
  if (diffDays <= daysLeftThisWeek) return "this-week";
  if (diffDays <= daysLeftThisWeek + 7) return "next-week";
  return "later";
}

export const DUE_FILTERS = ["today", "this-week", "next-week", "overdue"] as const;
export type DueFilter = (typeof DUE_FILTERS)[number];

export function matchesDueFilter(bucket: DueBucket, filter: DueFilter): boolean {
  switch (filter) {
    case "overdue":
      return bucket === "overdue";
    case "today":
      return bucket === "today";
    case "this-week":
      return bucket === "today" || bucket === "this-week";
    case "next-week":
      return bucket === "next-week";
  }
}

export function dueDateUrgency(
  date: Date | null,
  status: string
): "overdue" | "soon" | "normal" {
  if (!date || status === "DONE") return "normal";
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(date);
  due.setHours(0, 0, 0, 0);
  const diffDays = Math.round((due.getTime() - today.getTime()) / 86_400_000);
  if (diffDays < 0) return "overdue";
  if (diffDays <= 2) return "soon";
  return "normal";
}
