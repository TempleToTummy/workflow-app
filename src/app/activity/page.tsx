import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";
import { formatDate } from "@/lib/dates";
import { actionMeta, AUDIT_FILTER_GROUPS } from "@/lib/audit";
import { AuditFilters } from "@/components/audit-filters";
import type { Prisma } from "@prisma/client";

// The audit log: who changed what, and when.
//
// Admin-only, for the same reason Reports are — it's a firm-wide view, and an
// employee scoped to their own clients would otherwise see every other
// client's history through it. Per-engagement history is on the assignment
// page instead, where the existing visibility rules already apply.

const PAGE_SIZE = 100;

function toneClass(tone: "neutral" | "good" | "warn" | "bad"): string {
  switch (tone) {
    case "good":
      return "bg-accent-soft text-accent";
    case "warn":
      return "bg-[var(--status-review-soft)] text-[var(--status-review)]";
    case "bad":
      return "bg-overdue/10 text-overdue";
    default:
      return "bg-black/5 text-ink-muted";
  }
}

export default async function ActivityLogPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | undefined }>;
}) {
  await requireAdmin();
  const params = await searchParams;

  const actionFilter = params.action;
  const actorFilter = params.actorId;
  const clientFilter = params.clientId;
  const page = Math.max(1, Number(params.page) || 1);

  const clauses: Prisma.AuditEventWhereInput[] = [];
  if (actionFilter) clauses.push({ action: actionFilter });
  if (actorFilter) clauses.push({ actorId: actorFilter });
  if (clientFilter) clauses.push({ clientId: clientFilter });
  const where: Prisma.AuditEventWhereInput = clauses.length ? { AND: clauses } : {};

  const [events, total, clients, employees] = await Promise.all([
    prisma.auditEvent.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    prisma.auditEvent.count({ where }),
    prisma.client.findMany({ orderBy: { companyName: "asc" }, select: { id: true, companyName: true } }),
    prisma.employee.findMany({
      orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
      select: { id: true, firstName: true, lastName: true },
    }),
  ]);

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // Events are grouped under a date heading so a long feed stays scannable.
  const byDay = new Map<string, typeof events>();
  for (const e of events) {
    const key = formatDate(e.createdAt);
    const list = byDay.get(key);
    if (list) list.push(e);
    else byDay.set(key, [e]);
  }

  function pageHref(n: number): string {
    const p = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (key !== "page" && value) p.set(key, value);
    }
    if (n > 1) p.set("page", String(n));
    const q = p.toString();
    return q ? `/activity?${q}` : "/activity";
  }

  return (
    <div className="mx-auto w-full max-w-4xl px-8 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Activity log</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Every change to work, configuration and access, in order. Append-only —
          nothing here is edited or deleted, and entries outlive the records they
          describe.
        </p>
      </div>

      <div className="mb-4 rounded-lg border border-line bg-surface px-4 py-3">
        <AuditFilters
          groups={AUDIT_FILTER_GROUPS.map((g) => ({
            heading: g.heading,
            options: g.actions.map((a) => ({ value: a, label: actionMeta(a).label })),
          }))}
          clients={clients.map((c) => ({ value: c.id, label: c.companyName }))}
          actors={employees.map((e) => ({
            value: e.id,
            label: `${e.firstName} ${e.lastName}`,
          }))}
          total={total}
        />
      </div>

      {events.length === 0 ? (
        <div className="rounded-lg border border-dashed border-line px-4 py-12 text-center text-sm text-ink-muted">
          {total === 0 && !actionFilter && !actorFilter && !clientFilter
            ? "Nothing recorded yet. Changes from here on will appear in this log."
            : "No events match these filters."}
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          {[...byDay].map(([day, dayEvents]) => (
            <section key={day}>
              <h2 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-ink-muted">
                {day}
              </h2>
              <ol className="overflow-hidden rounded-lg border border-line bg-surface">
                {dayEvents.map((e) => {
                  const meta = actionMeta(e.action);
                  return (
                    <li
                      key={e.id}
                      className="flex flex-wrap items-start gap-x-3 gap-y-1 border-b border-line px-4 py-3 last:border-0"
                    >
                      <span className="tabular w-14 shrink-0 pt-0.5 text-xs text-ink-muted">
                        {e.createdAt.toLocaleTimeString("en-US", {
                          hour: "numeric",
                          minute: "2-digit",
                        })}
                      </span>
                      <span
                        className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${toneClass(
                          meta.tone
                        )}`}
                      >
                        {meta.label}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm text-ink">{e.summary}</p>
                        <p className="text-xs text-ink-muted">
                          {e.actorLabel}
                          {e.contextLabel && <> · {e.contextLabel}</>}
                          {e.periodName && <span className="tabular"> · {e.periodName}</span>}
                        </p>
                      </div>
                      {e.clientId && e.projectId && (
                        <Link
                          href={`/assignments/${e.clientId}/${e.projectId}`}
                          className="shrink-0 pt-0.5 text-xs text-accent hover:underline"
                        >
                          Open
                        </Link>
                      )}
                    </li>
                  );
                })}
              </ol>
            </section>
          ))}
        </div>
      )}

      {pageCount > 1 && (
        <div className="mt-6 flex items-center justify-between text-sm">
          {page > 1 ? (
            <Link href={pageHref(page - 1)} className="text-accent hover:underline">
              ← Newer
            </Link>
          ) : (
            <span />
          )}
          <span className="tabular text-ink-muted">
            Page {page} of {pageCount}
          </span>
          {page < pageCount ? (
            <Link href={pageHref(page + 1)} className="text-accent hover:underline">
              Older →
            </Link>
          ) : (
            <span />
          )}
        </div>
      )}
    </div>
  );
}
