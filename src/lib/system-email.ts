import { prisma } from "@/lib/prisma";
import {
  emailTransport,
  senderAddress,
  firmName,
  threadKeyFor,
  renderTemplate,
  textToHtml,
  type TemplateContext,
} from "@/lib/email";

// Mail the app sends on its own behalf, with no signed-in user behind it —
// today that means password reset links.
//
// This is deliberately NOT a server action and this file has no "use server"
// directive. Its one caller is an unauthenticated action (requesting a reset),
// so exposing it as a callable action would hand anyone an open relay that
// sends arbitrary text from the firm's address.
//
// Messages land in the same EmailMessage table as everything else, so they
// show up in /email and are subject to the same honest LOGGED-vs-SENT
// distinction: with no provider configured the link is recorded but not
// delivered, which is exactly why the admin-side "copy reset link" fallback
// exists.

export async function sendSystemEmail(input: {
  to: string;
  subject: string;
  body: string;
  templateKey?: string;
}): Promise<{ delivered: boolean; messageId: string }> {
  const from = senderAddress();

  const message = await prisma.emailMessage.create({
    data: {
      direction: "OUTBOUND",
      status: "QUEUED",
      threadKey: threadKeyFor({}),
      transport: emailTransport.name,
      fromEmail: from,
      fromName: firmName(),
      toEmail: input.to,
      subject: input.subject,
      bodyText: input.body,
      bodyHtml: textToHtml(input.body),
      templateKey: input.templateKey ?? null,
      // No sentById: nobody pressed send. Shows as a system message.
      sentById: null,
    },
  });

  // No Reply-To token: a reset mail is not a conversation, and threading a
  // reply onto it would attach it to nothing.
  const result = await emailTransport.send({
    from,
    to: input.to,
    subject: input.subject,
    text: input.body,
    html: textToHtml(input.body),
  });

  await prisma.emailMessage.update({
    where: { id: message.id },
    data: {
      status:
        result.outcome === "sent" ? "SENT" : result.outcome === "logged" ? "LOGGED" : "FAILED",
      providerId: result.providerId ?? null,
      error: result.error ?? null,
      sentAt: result.outcome === "failed" ? null : new Date(),
    },
  });

  return { delivered: result.outcome === "sent", messageId: message.id };
}

// The reset message. Kept in code rather than the EmailTemplate table on
// purpose: a security email must not stop working because somebody edited or
// deleted a row, and {{reset_url}} has to be filled by the system, not chosen
// by an author.
const RESET_SUBJECT = "Reset your {{firm_name}} password";

const RESET_BODY = `Hi {{first_name}},

Someone asked to reset the password for your {{firm_name}} workflow account ({{email}}).

Open this link to choose a new one:

{{reset_url}}

The link expires in {{expires_in}} and can only be used once. Signing in with it ends any other sessions on your account.

If this wasn't you, you can ignore this message — your password hasn't changed. If you keep getting these, tell your administrator.

{{firm_name}}`;

export function renderResetEmail(context: TemplateContext): {
  subject: string;
  body: string;
} {
  const full = { ...context, firm_name: context.firm_name || firmName() };
  return {
    subject: renderTemplate(RESET_SUBJECT, full),
    body: renderTemplate(RESET_BODY, full),
  };
}
