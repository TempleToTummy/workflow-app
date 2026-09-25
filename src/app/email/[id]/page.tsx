import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { formatDate } from "@/lib/dates";
import { EmailStatusBadge } from "@/components/email-status-badge";
import { EmailThreadReply } from "@/components/email-thread-reply";
import { composerClients, composerTemplates, messageScope } from "@/lib/email-data";
import { transportIsLive, replyToAddress } from "@/lib/email";

// One conversation. Opening any message shows the whole thread it belongs to,
// oldest first, with a reply box at the bottom that stays inside the thread.

export default async function EmailThreadPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;

  // The scope is applied to the lookup itself, so an employee opening a
  // message id they aren't entitled to gets a 404 rather than the content.
  const scope = messageScope(user);
  const message = await prisma.emailMessage.findFirst({
    where: Object.keys(scope).length ? { AND: [{ id }, scope] } : { id },
    include: { client: true, project: true },
  });
  if (!message) notFound();

  const [thread, clients, templates] = await Promise.all([
    prisma.emailMessage.findMany({
      where: { threadKey: message.threadKey },
      include: { sentBy: { select: { firstName: true, lastName: true } } },
      orderBy: { createdAt: "asc" },
    }),
    composerClients(user),
    composerTemplates(),
  ]);

  // Who a reply goes to: whoever we've been corresponding with, which is the
  // sender of the newest inbound message, or the recipient of the newest
  // outbound one.
  const newest = thread[thread.length - 1];
  const replyTo =
    newest.direction === "INBOUND" ? newest.fromEmail : newest.toEmail;
  const replySubject = /^re:/i.test(message.subject)
    ? message.subject
    : `Re: ${message.subject}`;

  const engagementHref =
    message.clientId && message.projectId
      ? `/assignments/${message.clientId}/${message.projectId}${
          message.periodName ? `?period=${encodeURIComponent(message.periodName)}` : ""
        }`
      : message.clientId
      ? `/clients/${message.clientId}`
      : null;

  return (
    <div className="mx-auto w-full max-w-3xl px-8 py-8">
      <Link href="/email" className="text-sm text-ink-muted hover:text-accent">
        ← All email
      </Link>

      <h1 className="mt-2 text-2xl font-semibold tracking-tight">{message.subject}</h1>
      <p className="mt-1 text-sm text-ink-muted">
        {message.client ? (
          <>
            {engagementHref ? (
              <Link href={engagementHref} className="hover:text-accent">
                {message.client.companyName}
                {message.project && <> · {message.project.name}</>}
              </Link>
            ) : (
              message.client.companyName
            )}
            {message.periodName && <span className="tabular"> · {message.periodName}</span>}
          </>
        ) : (
          <span className="italic">Not matched to a client</span>
        )}
        {" · "}
        {thread.length} {thread.length === 1 ? "message" : "messages"}
      </p>

      <ol className="mt-6 flex flex-col gap-3">
        {thread.map((m) => {
          const inbound = m.direction === "INBOUND";
          return (
            <li
              key={m.id}
              id={m.id}
              className={`rounded-lg border p-4 ${
                inbound
                  ? "border-accent/25 bg-accent-soft/40"
                  : "border-line bg-surface"
              } ${m.id === id ? "ring-1 ring-accent/40" : ""}`}
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-ink">
                    {inbound
                      ? m.fromName ?? m.fromEmail
                      : m.sentBy
                      ? `${m.sentBy.firstName} ${m.sentBy.lastName}`
                      : m.fromEmail}
                    <span className="ml-1.5 font-normal text-ink-muted">
                      {inbound ? `<${m.fromEmail}>` : `→ ${m.toEmail}`}
                    </span>
                  </p>
                  {m.cc && <p className="text-xs text-ink-muted">cc {m.cc}</p>}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <EmailStatusBadge status={m.status} />
                  <span className="text-xs text-ink-muted">
                    {formatDate(m.createdAt)}{" "}
                    {m.createdAt.toLocaleTimeString("en-US", {
                      hour: "numeric",
                      minute: "2-digit",
                    })}
                  </span>
                </div>
              </div>

              {m.subject !== message.subject && (
                <p className="mt-2 text-xs font-medium text-ink-muted">{m.subject}</p>
              )}

              <div className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-ink">
                {m.bodyText}
              </div>

              {m.error && (
                <p className="mt-3 rounded-md bg-overdue/10 px-3 py-2 text-xs text-overdue">
                  {m.error}
                </p>
              )}

              {m.templateKey && (
                <p className="mt-3 text-[11px] text-ink-muted">
                  Sent from the &ldquo;{m.templateKey}&rdquo; template
                </p>
              )}
            </li>
          );
        })}
      </ol>

      <div className="mt-6 rounded-lg border border-line bg-surface p-4">
        <h2 className="mb-3 text-sm font-semibold text-ink">Reply</h2>
        <EmailThreadReply
          clients={clients}
          templates={templates}
          live={transportIsLive()}
          clientId={message.clientId}
          projectId={message.projectId}
          periodName={message.periodName}
          threadKey={message.threadKey}
          replyTo={replyTo}
          subject={replySubject}
          failedMessage={
            newest.direction === "OUTBOUND" &&
            (newest.status === "FAILED" || newest.status === "BOUNCED")
              ? { id: newest.id, error: newest.error }
              : null
          }
        />
      </div>

      {message.replyToken && replyToAddress(message.replyToken) && (
        <p className="mt-4 text-center text-[11px] text-ink-muted">
          Replies to this conversation are routed through{" "}
          <code className="rounded bg-black/5 px-1">
            {replyToAddress(message.replyToken)}
          </code>
        </p>
      )}
    </div>
  );
}
