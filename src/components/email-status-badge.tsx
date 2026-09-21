import type { EmailStatus } from "@prisma/client";

// Status pill for a message. LOGGED gets its own treatment on purpose: it
// means the row exists but nothing was delivered because no mail provider is
// configured, and that must not read as a successful send.
const STYLES: Record<EmailStatus, { label: string; className: string; title: string }> = {
  QUEUED: {
    label: "Queued",
    className: "bg-black/5 text-ink-muted",
    title: "Accepted, not yet handed to the provider.",
  },
  SENT: {
    label: "Sent",
    className: "bg-accent-soft text-accent",
    title: "The mail provider accepted this message.",
  },
  DELIVERED: {
    label: "Delivered",
    className: "bg-accent-soft text-accent",
    title: "The provider confirmed delivery.",
  },
  LOGGED: {
    label: "Not sent",
    className: "bg-[var(--status-review-soft)] text-[var(--status-review)]",
    title:
      "Recorded only — no mail provider is configured, so nothing was delivered. Set RESEND_API_KEY to send for real.",
  },
  FAILED: {
    label: "Failed",
    className: "bg-overdue/10 text-overdue",
    title: "The provider rejected this message.",
  },
  BOUNCED: {
    label: "Bounced",
    className: "bg-overdue/10 text-overdue",
    title: "The recipient's server rejected it.",
  },
  RECEIVED: {
    label: "Received",
    className: "bg-black/5 text-ink-muted",
    title: "An inbound reply.",
  },
};

export function EmailStatusBadge({ status }: { status: EmailStatus }) {
  const style = STYLES[status];
  return (
    <span
      title={style.title}
      className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${style.className}`}
    >
      {style.label}
    </span>
  );
}

export const EMAIL_STATUS_OPTIONS = (Object.keys(STYLES) as EmailStatus[]).map((value) => ({
  value,
  label: STYLES[value].label,
}));
