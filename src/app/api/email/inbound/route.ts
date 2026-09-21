import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  verifyInboundSignature,
  parseInboundPayload,
  fetchReceivedEmail,
  extractReplyToken,
  stripQuotedReply,
  threadKeyFor,
} from "@/lib/email";

// Inbound mail webhook.
//
// The provider is configured with a catch-all route on EMAIL_INBOUND_DOMAIN
// and posts each parsed message here. Every outbound message we send carries a
// Reply-To of <prefix>+<token>@<domain>, so a reply arrives addressed to that
// token and we can thread it onto the exact engagement it belongs to without
// guessing from the subject line.
//
// Resolution order:
//   1. The reply token in the To: address — exact, and the normal path.
//   2. The sender's address matched against client contacts and client emails
//      — covers a client who composes a fresh message instead of replying.
//   3. Neither: the message is still stored, unattached, so nothing is lost.
//      It shows in /email under "Unmatched".
//
// Guarded by EMAIL_INBOUND_SECRET (Svix-style headers, a plain HMAC header, or
// a bearer token — see verifyInboundSignature). With no secret set the
// endpoint refuses everything rather than accepting anonymous writes.
//
// NOTE: inbound payload shapes differ between providers and this parser reads
// the union of the common spellings rather than committing to one vendor's
// envelope. Confirm the field names against your provider's actual webhook
// before relying on it in production.

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  // The signature covers the exact bytes, so verify before parsing JSON.
  const rawBody = await request.text();

  const verification = verifyInboundSignature(rawBody, request.headers);
  if (!verification.ok) {
    return NextResponse.json({ error: verification.reason ?? "Unauthorized." }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Body was not valid JSON." }, { status: 400 });
  }

  const parsed = parseInboundPayload(payload);
  if (!parsed) {
    return NextResponse.json(
      { error: "Could not find a sender address in the payload." },
      { status: 422 }
    );
  }

  // Resend's email.received webhook carries metadata only, so when no body
  // came with it we fetch the message. Recipients are merged too: the reply
  // token lives in the To: address, and the full record is the more reliable
  // place to find it. A failed fetch is non-fatal — the message is still
  // stored from the webhook metadata rather than dropped.
  let bodyFetchFailed = false;
  if (!parsed.text && !parsed.html && parsed.emailId) {
    const full = await fetchReceivedEmail(parsed.emailId);
    if (full) {
      parsed.text = full.text ?? "";
      parsed.html = full.html;
      if (full.to.length) parsed.to = [...new Set([...parsed.to, ...full.to])];
      if (full.subject) parsed.subject = full.subject;
      parsed.providerId = parsed.providerId ?? full.messageId;
    } else {
      bodyFetchFailed = true;
    }
  }

  // --- 1. Thread by reply token -------------------------------------------
  const token = extractReplyToken(parsed.to);
  let original = token
    ? await prisma.emailMessage.findUnique({ where: { replyToken: token } })
    : null;

  // --- 2. Fall back to matching the sender --------------------------------
  let clientId = original?.clientId ?? null;
  let projectId = original?.projectId ?? null;
  let periodName = original?.periodName ?? null;

  if (!original) {
    const contact = await prisma.corpContact.findFirst({
      where: { email: parsed.from },
      select: { clientId: true },
    });
    const client =
      contact?.clientId ??
      (await prisma.client.findFirst({ where: { email: parsed.from }, select: { id: true } }))?.id ??
      null;

    if (client) {
      clientId = client;
      // Attach it to that client's most recent conversation when there is one,
      // so a reply from a known contact doesn't start an orphan thread.
      original = await prisma.emailMessage.findFirst({
        where: { clientId: client, direction: "OUTBOUND" },
        orderBy: { createdAt: "desc" },
      });
      projectId = original?.projectId ?? null;
      periodName = original?.periodName ?? null;
    }
  }

  const threadKey =
    original?.threadKey ??
    (clientId ? threadKeyFor({ clientId, projectId, periodName }) : `inbound:${parsed.from}`);

  const text = parsed.text ? stripQuotedReply(parsed.text) : "";

  const message = await prisma.emailMessage.create({
    data: {
      direction: "INBOUND",
      status: "RECEIVED",
      clientId,
      projectId,
      periodName,
      threadKey,
      providerId: parsed.providerId,
      transport: "inbound",
      fromEmail: parsed.from,
      fromName: parsed.fromName,
      toEmail: parsed.to[0] ?? "",
      subject: parsed.subject,
      bodyText:
        text ||
        (bodyFetchFailed
          ? "(The body could not be retrieved from the mail provider. Open the message in the provider's dashboard.)"
          : "(empty message)"),
      bodyHtml: parsed.html,
      receivedAt: new Date(),
    },
  });

  return NextResponse.json({
    id: message.id,
    threadKey,
    matched: clientId ? (token ? "reply-token" : "sender-address") : "unmatched",
    bodyFetchFailed,
  });
}

// A GET is handy for confirming the route is reachable and whether the secret
// is configured, without accepting a write.
export async function GET() {
  return NextResponse.json({
    ok: true,
    configured: Boolean(process.env.EMAIL_INBOUND_SECRET),
    inboundDomain: process.env.EMAIL_INBOUND_DOMAIN ?? null,
  });
}
