import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { formatDate } from "@/lib/dates";
import { FilterBar } from "@/components/filter-bar";
import { EmailStatusBadge, EMAIL_STATUS_OPTIONS } from "@/components/email-status-badge";
import { messageScope } from "@/lib/email-data";
import { transportIsLive, inboundConfigured } from "@/lib/email";
import type { EmailStatus, Prisma } from "@prisma/client";

// Firm-wide correspondence. One row per message, newest first, filterable by
// client, project and status, with tabs across the top for the views people
// actually want: everything, what went out, what came back, and what broke.

type View = "all" | "sent" | "received" | "failed" | "unmatched";

const VIEWS: { id: View; label: string }[] = [
  { id: "all", label: "All" },
  { id: "sent", label: "Sent" },
  { id: "received", label: "Received" },
  { id: "failed", label: "Needs attention" },
  { id: "unmatched", label: "Unmatched" },
];

// The `where` fragment each tab adds on top of the shared filters.
function viewWhere(view: View): Prisma.EmailMessageWhereInput {
  switch (view) {
    case "sent":
      return { direction: "OUTBOUND" };
    case "received":
      return { direction: "INBOUND" };
    case "failed":
      return { status: { in: ["FAILED", "BOUNCED", "QUEUED"] } };
    case "unmatched":
      // Inbound mail we couldn't attach to a client — someone has to look at
      // these by hand, so they get their own tab rather than being buried.
      return { direction: "INBOUND", clientId: null };
    case "all":
      return {};
  }
}

export default async function EmailPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | undefined }>;
}) {
  const user = await requireUser();
  const params = await searchParams;

  const view: View = VIEWS.some((v) => v.id === params.view)
    ? (params.view as View)
    : "all";
  const clientFilter = params.clientId;
  const projectFilter = params.projectId;
  const statusFilter = params.status as EmailStatus | undefined;
  const query = (params.q ?? "").trim();

  // Every restriction goes in its own AND clause. The visibility scope and the
  // search both need an OR, and merging two ORs into one object would silently
  // drop the first — which would show an employee the whole firm's mail.
  const scope = messageScope(user);
  const clauses: Prisma.EmailMessageWhereInput[] = [];
  if (Object.keys(scope).length > 0) clauses.push(scope);
  if (clientFilter) clauses.push({ clientId: clientFilter });
  if (projectFilter) clauses.push({ projectId: projectFilter });
  if (statusFilter) clauses.push({ status: statusFilter });
  if (query) {
    clauses.push({
      OR: [
        { subject: { contains: query } },
        { bodyText: { contains: query } },
        { toEmail: { contains: query } },
        { fromEmail: { contains: query } },
      ],
    });
  }
  const where: Prisma.EmailMessageWhereInput = clauses.length ? { AND: clauses } : {};

  const [messages, counts, clients, projects] = await Promise.all([
    prisma.emailMessage.findMany({
      where: { AND: [where, viewWhere(view)] },
      include: {
        client: { select: { companyName: true } },
        project: { select: { name: true } },
        sentBy: { select: { firstName: true, lastName: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 200,
    }),
    Promise.all(
      VIEWS.map(async (v) => ({
        id: v.id,
        count: await prisma.emailMessage.count({
          where: { AND: [where, viewWhere(v.id)] },
        }),
      }))
    ),
    prisma.client.findMany({
      where: {
        archivedAt: null,
        ...(user.role === "ADMIN" ? {} : { activities: { some: { assigneeId: user.id } } }),
      },
      orderBy: { companyName: "asc" },
      select: { id: true, companyName: true },
    }),
    prisma.project.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);

  const countBy = new Map(counts.map((c) => [c.id, c.count]));
  const live = transportIsLive();

  function viewHref(id: View): string {
    const p = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (key !== "view" && value) p.set(key, value);
    }
    if (id !== "all") p.set("view", id);
    const q = p.toString();
    return q ? `/email?${q}` : "/email";
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-8 py-8">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Email</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Every message to and from clients, threaded onto the engagement it&apos;s
            about.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/email/templates"
            className="rounded-md border border-line px-4 py-2 text-sm font-medium text-ink hover:bg-black/5"
          >
            Templates
          </Link>
          <Link
            href="/email/new"
            className="whitespace-nowrap rounded-full bg-accent px-4 py-2 text-sm font-medium text-white shadow-sm hover:opacity-90"
          >
            + Compose
          </Link>
        </div>
      </div>

      {!live && (
        <div className="mb-4 rounded-lg border border-[var(--status-review)]/30 bg-[var(--status-review-soft)] px-4 py-3 text-xs text-[var(--status-review)]">
          <strong className="font-semibold">No mail provider is configured.</strong> Messages
          are composed, templated and recorded, but nothing is delivered. Set{" "}
          <code className="rounded bg-black/5 px-1">RESEND_API_KEY</code> to send for real
          {!inboundConfigured() && (
            <>
              , and <code className="rounded bg-black/5 px-1">EMAIL_INBOUND_DOMAIN</code> plus{" "}
              <code className="rounded bg-black/5 px-1">EMAIL_INBOUND_SECRET</code> to receive
              replies
            </>
          )}
          .
        </div>
      )}

      <div className="mb-4 inline-flex flex-wrap rounded-md border border-line bg-surface p-0.5 shadow-sm">
        {VIEWS.map((v) => {
          const active = v.id === view;
          const count = countBy.get(v.id) ?? 0;
          // "Unmatched" is noise when it's empty — it only earns a tab when
          // there's actually something sitting in it.
          if (v.id === "unmatched" && count === 0 && view !== "unmatched") return null;
          return (
            <Link
              key={v.id}
              href={viewHref(v.id)}
              aria-current={active ? "page" : undefined}
              className={`flex items-center gap-1.5 rounded px-3 py-1.5 text-sm font-medium transition-colors ${
                active ? "bg-accent-soft text-accent" : "text-ink-muted hover:text-ink"
              }`}
            >
              {v.label}
              <span
                className={`count-pill ${
                  active ? "bg-accent/15 text-accent" : "bg-black/5 text-ink-muted"
                }`}
              >
                {count}
              </span>
            </Link>
          );
        })}
      </div>

      <div className="mb-4 rounded-lg border border-line bg-surface px-4 py-3">
        <FilterBar
          search
          searchPlaceholder="Search subject, body, or address"
          clients={clients.map((c) => ({ value: c.id, label: c.companyName }))}
          projects={projects.map((p) => ({ value: p.id, label: p.name }))}
          statuses={EMAIL_STATUS_OPTIONS}
          trailing={
            <span className="whitespace-nowrap text-sm text-ink-muted">
              {messages.length} {messages.length === 1 ? "message" : "messages"}
            </span>
          }
        />
      </div>

      <div className="overflow-x-auto rounded-lg border border-line bg-surface shadow-sm">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-line bg-black/[0.02] text-xs uppercase tracking-wide text-ink-muted">
              <th className="px-4 py-3 font-medium">Message</th>
              <th className="px-4 py-3 font-medium">Engagement</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">When</th>
            </tr>
          </thead>
          <tbody>
            {messages.map((m) => {
              const inbound = m.direction === "INBOUND";
              const counterparty = inbound ? m.fromEmail : m.toEmail;
              return (
                <tr
                  key={m.id}
                  className="border-b border-line last:border-0 hover:bg-black/[0.015]"
                >
                  <td className="px-4 py-3">
                    <div className="flex items-start gap-2">
                      <span
                        title={inbound ? "Received" : "Sent"}
                        className={`mt-0.5 shrink-0 text-xs ${
                          inbound ? "text-accent" : "text-ink-muted"
                        }`}
                      >
                        {inbound ? "↓" : "↑"}
                      </span>
                      <div className="min-w-0">
                        <Link
                          href={`/email/${m.id}`}
                          className="block truncate font-medium text-ink hover:text-accent"
                        >
                          {m.subject}
                        </Link>
                        <p className="truncate text-xs text-ink-muted">
                          {inbound ? "from" : "to"} {counterparty}
                          {m.sentBy && !inbound && (
                            <> · {m.sentBy.firstName} {m.sentBy.lastName}</>
                          )}
                        </p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-ink-muted">
                    {m.client ? (
                      <>
                        <div className="truncate">{m.client.companyName}</div>
                        {m.project && (
                          <div className="truncate text-xs">
                            {m.project.name}
                            {m.periodName && (
                              <span className="tabular"> · {m.periodName}</span>
                            )}
                          </div>
                        )}
                      </>
                    ) : (
                      <span className="text-xs italic">Not matched to a client</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <EmailStatusBadge status={m.status} />
                  </td>
                  <td className="px-4 py-3 text-xs text-ink-muted">
                    {formatDate(m.createdAt)}
                    <div>
                      {m.createdAt.toLocaleTimeString("en-US", {
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </div>
                  </td>
                </tr>
              );
            })}
            {messages.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-12 text-center text-ink-muted">
                  {view === "all" && !query && !clientFilter ? (
                    <>
                      No messages yet.{" "}
                      <Link href="/email/new" className="text-accent hover:underline">
                        Compose the first one
                      </Link>
                      .
                    </>
                  ) : (
                    "No messages match these filters."
                  )}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
