import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { listMentions } from "@/lib/comment-data";
import { MentionList } from "@/components/mention-list";

// Your @mentions.
//
// There is no separate notification model: a TaskCommentMention row IS the
// notification, so there's no second table to keep in step with the comments
// and nothing that can disagree with them.
//
// Not admin-gated — everyone has their own mentions, and this only ever shows
// the caller's own rows.
export default async function MentionsPage({
  searchParams,
}: {
  searchParams: Promise<{ show?: string }>;
}) {
  const user = await requireUser();
  const { show } = await searchParams;
  const unreadOnly = show !== "all";

  const mentions = await listMentions({ employeeId: user.id, unreadOnly });

  const rows = mentions.map((m) => ({
    id: m.id,
    body: m.comment.body,
    authorLabel: m.comment.authorLabel,
    createdAt: m.comment.createdAt.toISOString(),
    read: m.readAt !== null,
    clientName: m.comment.activity.client.companyName,
    projectName: m.comment.activity.project.name,
    stepName: m.comment.activity.subTask.name,
    periodName: m.comment.activity.periodName,
    href: `/assignments/${m.comment.activity.clientId}/${m.comment.activity.projectId}`,
  }));

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Mentions</h1>
      <p className="mt-1 text-sm text-ink-muted">
        Where a colleague has pulled you into a task by name.
      </p>

      <div className="no-print mt-5 flex items-center gap-1.5">
        {[
          { key: "unread", label: "Unread", href: "/mentions" },
          { key: "all", label: "All", href: "/mentions?show=all" },
        ].map((tab) => {
          const active = (tab.key === "unread") === unreadOnly;
          return (
            <Link
              key={tab.key}
              href={tab.href}
              aria-current={active ? "page" : undefined}
              className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                active
                  ? "border-accent bg-accent-soft text-accent"
                  : "border-line text-ink-muted hover:border-ink-muted/40 hover:text-ink"
              }`}
            >
              {tab.label}
            </Link>
          );
        })}
      </div>

      <div className="mt-5">
        <MentionList mentions={rows} unreadOnly={unreadOnly} />
      </div>
    </div>
  );
}
