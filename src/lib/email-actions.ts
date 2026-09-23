"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireUser, requireAdmin, assigneeScope } from "@/lib/auth";
import { formatDueDate } from "@/lib/dates";
import {
  emailTransport,
  senderAddress,
  firmName,
  newReplyToken,
  replyToAddress,
  threadKeyFor,
  renderTemplate,
  textToHtml,
  parseAddressList,
  isValidAddress,
  type TemplateContext,
} from "@/lib/email";

// Email server actions, kept out of the already-large src/lib/actions.ts the
// same way auth-actions.ts is. Every action guards itself — server actions are
// reachable by direct POST, and an employee must not be able to send mail on
// behalf of a client they can't see.

// An EMPLOYEE may only correspond about engagements they have a task on;
// ADMIN is unrestricted. Mirrors assigneeScope() on the read side.
async function assertCanEmailClient(clientId: string | null | undefined) {
  const user = await requireUser();
  const mine = assigneeScope(user);
  if (!mine || !clientId) return user;
  const onIt = await prisma.clientActivity.count({
    where: { clientId, assigneeId: mine },
  });
  if (onIt === 0) {
    throw new Error("You don't have any work with this client.");
  }
  return user;
}

export type SendEmailInput = {
  clientId?: string | null;
  projectId?: string | null;
  periodName?: string | null;
  toEmail: string;
  toName?: string | null;
  cc?: string | null;
  subject: string;
  body: string;
  templateKey?: string | null;
  // Set when replying inside an existing conversation, so the reply lands in
  // the same thread instead of starting a new one.
  threadKey?: string | null;
};

export async function sendEmailMessage(input: SendEmailInput) {
  const user = await assertCanEmailClient(input.clientId);

  const toEmail = input.toEmail.trim().toLowerCase();
  const subject = input.subject.trim();
  const body = input.body.trim();

  if (!isValidAddress(toEmail)) throw new Error("That recipient address doesn't look valid.");
  if (!subject) throw new Error("A subject is required.");
  if (!body) throw new Error("The message body is empty.");

  const cc = parseAddressList(input.cc);
  const badCc = cc.find((address) => !isValidAddress(address));
  if (badCc) throw new Error(`"${badCc}" doesn't look like a valid address.`);

  const threadKey =
    input.threadKey ??
    threadKeyFor({
      clientId: input.clientId,
      projectId: input.projectId,
      periodName: input.periodName,
    });

  const replyToken = newReplyToken();
  const from = senderAddress();
  const senderName = `${user.firstName} ${user.lastName}`;

  // The row is written before the send attempt, so a provider timeout leaves a
  // record to retry rather than a message that vanished.
  const message = await prisma.emailMessage.create({
    data: {
      direction: "OUTBOUND",
      status: "QUEUED",
      clientId: input.clientId ?? null,
      projectId: input.projectId ?? null,
      periodName: input.periodName ?? null,
      threadKey,
      replyToken,
      transport: emailTransport.name,
      fromEmail: from,
      fromName: senderName,
      toEmail,
      toName: input.toName?.trim() || null,
      cc: cc.length ? cc.join(", ") : null,
      subject,
      bodyText: body,
      bodyHtml: textToHtml(body),
      templateKey: input.templateKey ?? null,
      sentById: user.id,
    },
  });

  const result = await emailTransport.send({
    from,
    to: toEmail,
    cc,
    replyTo: replyToAddress(replyToken) ?? undefined,
    subject,
    text: body,
    html: textToHtml(body),
  });

  const updated = await prisma.emailMessage.update({
    where: { id: message.id },
    data: {
      status:
        result.outcome === "sent"
          ? "SENT"
          : result.outcome === "logged"
          ? "LOGGED"
          : "FAILED",
      providerId: result.providerId ?? null,
      error: result.error ?? null,
      sentAt: result.outcome === "failed" ? null : new Date(),
    },
  });

  revalidatePath("/email");
  revalidatePath(`/email/${message.id}`);
  if (input.clientId) revalidatePath(`/clients/${input.clientId}`);

  return {
    id: updated.id,
    status: updated.status,
    error: updated.error,
    transport: emailTransport.name,
  };
}

// Retry a message the provider rejected. Sends the stored content again rather
// than asking the user to retype it; a fresh row would lose the thread.
export async function retryEmailMessage(messageId: string) {
  const existing = await prisma.emailMessage.findUniqueOrThrow({ where: { id: messageId } });
  await assertCanEmailClient(existing.clientId);

  if (existing.direction !== "OUTBOUND") {
    throw new Error("Only outbound messages can be retried.");
  }
  if (existing.status === "SENT" || existing.status === "DELIVERED") {
    throw new Error("That message was already sent.");
  }

  const token = existing.replyToken ?? newReplyToken();
  const result = await emailTransport.send({
    from: senderAddress(),
    to: existing.toEmail,
    cc: parseAddressList(existing.cc),
    replyTo: replyToAddress(token) ?? undefined,
    subject: existing.subject,
    text: existing.bodyText,
    html: existing.bodyHtml ?? textToHtml(existing.bodyText),
  });

  await prisma.emailMessage.update({
    where: { id: messageId },
    data: {
      status:
        result.outcome === "sent" ? "SENT" : result.outcome === "logged" ? "LOGGED" : "FAILED",
      providerId: result.providerId ?? existing.providerId,
      transport: emailTransport.name,
      replyToken: token,
      error: result.error ?? null,
      sentAt: result.outcome === "failed" ? null : new Date(),
    },
  });

  revalidatePath("/email");
  revalidatePath(`/email/${messageId}`);
  return { status: result.outcome, error: result.error ?? null };
}

// --- Template context ---------------------------------------------------------

// Resolves the {{placeholders}} for one engagement. Used by the compose screen
// to preview a template against real data before anything is sent.
export async function buildTemplateContext(input: {
  clientId?: string | null;
  projectId?: string | null;
  periodName?: string | null;
  contactFirstName?: string | null;
}): Promise<TemplateContext> {
  // The preview reads live engagement data (open task count, next step, due
  // date), so it needs the same access as sending — otherwise it's a way to
  // read another client's progress by id.
  const user = await assertCanEmailClient(input.clientId);

  const context: TemplateContext = {
    sender_name: `${user.firstName} ${user.lastName}`,
    firm_name: firmName(),
    client_name: "",
    contact_first_name: input.contactFirstName?.trim() ?? "",
    project_name: "",
    period: input.periodName ?? "",
    due_date: "",
    open_tasks: "",
    next_task: "",
  };

  if (input.clientId) {
    const client = await prisma.client.findUnique({
      where: { id: input.clientId },
      select: { companyName: true },
    });
    context.client_name = client?.companyName ?? "";
  }

  if (input.clientId && input.projectId) {
    const [project, assignment] = await Promise.all([
      prisma.project.findUnique({
        where: { id: input.projectId },
        select: { name: true },
      }),
      prisma.projectClientMap.findUnique({
        where: { clientId_projectId: { clientId: input.clientId, projectId: input.projectId } },
        select: { currentPeriod: true },
      }),
    ]);
    context.project_name = project?.name ?? "";

    const periodName = input.periodName ?? assignment?.currentPeriod ?? null;
    context.period = periodName ?? "";

    if (periodName) {
      const activities = await prisma.clientActivity.findMany({
        where: { clientId: input.clientId, projectId: input.projectId, periodName },
        include: { subTask: true },
        orderBy: { taskSeqNo: "asc" },
      });
      const open = activities.filter((a) => a.status !== "DONE");
      context.open_tasks = String(open.length);
      context.next_task = open[0]?.subTask.name ?? "";
      // The engagement's deadline is the next open step's date, matching what
      // the dashboard row shows.
      const dated = open.filter((a) => a.dueDate);
      const due =
        dated.length > 0
          ? dated.reduce((min, a) => (a.dueDate! < min.dueDate! ? a : min)).dueDate
          : null;
      context.due_date = due ? formatDueDate(due) : "";
    }
  }

  return context;
}

// Renders a stored template against an engagement — one round trip for the
// compose screen instead of shipping every template body to the client.
export async function renderTemplateForEngagement(input: {
  templateKey: string;
  clientId?: string | null;
  projectId?: string | null;
  periodName?: string | null;
  contactFirstName?: string | null;
}) {
  await requireUser();
  const template = await prisma.emailTemplate.findUnique({
    where: { key: input.templateKey },
  });
  if (!template) throw new Error("That template no longer exists.");

  const context = await buildTemplateContext(input);
  return {
    subject: renderTemplate(template.subject, context),
    body: renderTemplate(template.body, context),
  };
}

// --- Templates ----------------------------------------------------------------

export type EmailTemplateInput = {
  name: string;
  subject: string;
  body: string;
  description?: string | null;
};

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "template"
  );
}

export async function createEmailTemplate(data: EmailTemplateInput) {
  await requireAdmin();
  const name = data.name.trim();
  if (!name) throw new Error("A template name is required.");
  if (!data.subject.trim()) throw new Error("A subject is required.");
  if (!data.body.trim()) throw new Error("A body is required.");

  let key = slugify(name);
  // Keys are the stable handle a message records, so collisions get suffixed
  // rather than overwriting someone else's template.
  for (let n = 2; await prisma.emailTemplate.findUnique({ where: { key } }); n += 1) {
    key = `${slugify(name)}-${n}`;
  }

  const created = await prisma.emailTemplate.create({
    data: {
      key,
      name,
      subject: data.subject.trim(),
      body: data.body.trim(),
      description: data.description?.trim() || null,
    },
  });
  revalidatePath("/email/templates");
  revalidatePath("/email/new");
  return { key: created.key };
}

export async function updateEmailTemplate(id: string, data: EmailTemplateInput) {
  await requireAdmin();
  if (!data.name.trim()) throw new Error("A template name is required.");
  if (!data.subject.trim()) throw new Error("A subject is required.");
  if (!data.body.trim()) throw new Error("A body is required.");

  await prisma.emailTemplate.update({
    where: { id },
    data: {
      name: data.name.trim(),
      subject: data.subject.trim(),
      body: data.body.trim(),
      description: data.description?.trim() || null,
    },
  });
  revalidatePath("/email/templates");
  revalidatePath("/email/new");
}

export async function deleteEmailTemplate(id: string) {
  await requireAdmin();
  await prisma.emailTemplate.delete({ where: { id } });
  revalidatePath("/email/templates");
  revalidatePath("/email/new");
}
