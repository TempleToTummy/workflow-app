import { prisma } from "@/lib/prisma";
import { formatDate } from "@/lib/dates";
import { actionMeta } from "@/lib/audit";

// The history of one engagement, rendered in the right rail of the assignment
// page. A server component so it can read directly — this needs no
// interactivity beyond being there.
//
// Unlike /activity, this is visible to anyone who can already open the
// engagement: it only ever shows events for this client and project, so it
// leaks nothing the page itself doesn't.
export async function EngagementHistory({
  clientId,
  projectId,
  periodName,
  limit = 12,
}: {
  clientId: string;
  projectId: string;
  // When set, narrows to the period on screen; otherwise the whole engagement.
  periodName?: string | null;
  limit?: number;
}) {
  const events = await prisma.auditEvent.findMany({
    where: {
      clientId,
      projectId,
      ...(periodName ? { OR: [{ periodName }, { periodName: null }] } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  return (
    <div className="rounded-lg border border-line bg-surface p-4">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
        History
      </h3>

      {events.length === 0 ? (
        <p className="mt-3 text-xs text-ink-muted">
          Nothing recorded yet. Status changes, reassignments and due-date edits
          show up here.
        </p>
      ) : (
        <ol className="mt-3 flex flex-col gap-2.5">
          {events.map((e) => (
            <li key={e.id} className="text-xs leading-snug">
              <p className="text-ink">{e.summary}</p>
              <p className="text-ink-muted">
                {e.actorLabel} · {formatDate(e.createdAt)}{" "}
                {e.createdAt.toLocaleTimeString("en-US", {
                  hour: "numeric",
                  minute: "2-digit",
                })}
                <span className="ml-1 opacity-70">({actionMeta(e.action).label})</span>
              </p>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
