import type { ActivityStatus } from "@prisma/client";

const STATUS_LABEL: Record<ActivityStatus, string> = {
  NOT_STARTED: "Not started",
  IN_PROGRESS: "In progress",
  AWAITING_REVIEW: "Awaiting review",
  DONE: "Done",
};

const STATUS_CLASSES: Record<ActivityStatus, string> = {
  NOT_STARTED: "text-ink-muted bg-black/5",
  IN_PROGRESS: "text-[var(--status-in-progress)] bg-[var(--status-in-progress-soft)]",
  AWAITING_REVIEW: "text-[var(--status-review)] bg-[var(--status-review-soft)]",
  DONE: "text-[var(--status-done)] bg-[var(--status-done-soft)]",
};

export function StatusBadge({ status }: { status: ActivityStatus }) {
  return (
    <span
      // `status-badge` is what the print stylesheet keys on to keep these
      // coloured on paper: green/amber/red IS the information in this cell.
      className={`status-badge inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${STATUS_CLASSES[status]}`}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

export { STATUS_LABEL, STATUS_CLASSES };
