"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { markAllMentionsRead, markMentionRead } from "@/lib/comment-actions";
import { formatDate } from "@/lib/dates";

export type MentionRow = {
  id: string;
  body: string;
  authorLabel: string;
  createdAt: string;
  read: boolean;
  clientName: string;
  projectName: string;
  stepName: string;
  periodName: string | null;
  href: string;
};

export function MentionList({
  mentions,
  unreadOnly,
}: {
  mentions: MentionRow[];
  unreadOnly: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const unread = mentions.filter((m) => !m.read).length;

  if (mentions.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-line px-4 py-10 text-center text-sm text-ink-muted">
        {unreadOnly ? "Nothing unread." : "Nobody has mentioned you yet."}
      </p>
    );
  }

  return (
    <div>
      {unread > 0 && (
        <div className="mb-3 flex justify-end">
          <button
            type="button"
            disabled={isPending}
            onClick={() => {
              setError(null);
              startTransition(async () => {
                try {
                  await markAllMentionsRead();
                  router.refresh();
                } catch (err) {
                  setError(err instanceof Error ? err.message : "Couldn't do that.");
                }
              });
            }}
            className="rounded-full border border-line bg-surface px-3 py-1 text-xs font-medium text-ink hover:bg-black/5 disabled:opacity-50"
          >
            Mark all read
          </button>
        </div>
      )}

      <ul className="flex flex-col gap-2">
        {mentions.map((m) => (
          <li
            key={m.id}
            className={`rounded-lg border px-4 py-3 ${
              m.read ? "border-line bg-surface" : "border-accent/30 bg-accent-soft"
            }`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs text-ink-muted">
                  <span className="font-medium text-ink">{m.authorLabel}</span> mentioned you
                  on{" "}
                  <span className="font-medium text-ink">{m.stepName}</span>
                </p>
                <p className="text-[11px] text-ink-muted">
                  {m.clientName} · {m.projectName}
                  {m.periodName && ` · ${m.periodName}`} · {formatDate(m.createdAt)}
                </p>
              </div>
              {!m.read && (
                <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-accent" aria-label="Unread" />
              )}
            </div>

            <p className="mt-2 line-clamp-3 text-sm whitespace-pre-wrap text-ink">{m.body}</p>

            <div className="mt-2 flex items-center gap-3 text-xs">
              <Link
                href={m.href}
                // Opening the task is the natural "I've seen this", so it
                // marks the mention read on the way — nobody should have to
                // tidy an inbox by hand after already dealing with it.
                onClick={() => {
                  if (m.read) return;
                  startTransition(async () => {
                    try {
                      await markMentionRead(m.id);
                    } catch {
                      // Navigation is what matters; a failed read-stamp just
                      // means it stays unread, which is recoverable.
                    }
                  });
                }}
                className="font-medium text-accent hover:underline"
              >
                Open the task →
              </Link>
              {!m.read && (
                <button
                  type="button"
                  disabled={isPending}
                  onClick={() => {
                    setError(null);
                    startTransition(async () => {
                      try {
                        await markMentionRead(m.id);
                        router.refresh();
                      } catch (err) {
                        setError(err instanceof Error ? err.message : "Couldn't do that.");
                      }
                    });
                  }}
                  className="text-ink-muted hover:text-ink disabled:opacity-50"
                >
                  Mark read
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>

      {error && <p className="mt-2 text-xs text-overdue">{error}</p>}
    </div>
  );
}
