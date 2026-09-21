import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";

// --- The single swap point between logging mail and actually sending it ------
//
// Shaped the same way src/lib/storage.ts is: one interface, one export to
// change. A message is composed and stored as an EmailMessage row either way;
// the transport only decides whether anything leaves the building.
//
//   LogTransport    (default) records the message and delivers nothing. The
//                   app therefore works with zero configuration, and the UI
//                   says plainly that nothing was sent.
//   ResendTransport POSTs to api.resend.com using fetch — no new dependency.
//                   Selected automatically once RESEND_API_KEY is set.
//
// To move to a different provider, write a class with the same `send` and
// change `pickTransport` below. No schema change: providerId/transport on the
// row already hold whatever the provider hands back.

export type OutboundMessage = {
  from: string; // "Name <addr@example.com>" or a bare address
  to: string;
  cc?: string[];
  replyTo?: string;
  subject: string;
  text: string;
  html?: string;
};

export type SendResult = {
  // "sent" = the provider accepted it. "logged" = recorded, not delivered.
  outcome: "sent" | "logged" | "failed";
  providerId?: string;
  error?: string;
};

export interface EmailTransport {
  readonly name: string;
  send(message: OutboundMessage): Promise<SendResult>;
}

// Records and delivers nothing. Deliberately reports "logged" rather than
// "sent" — telling the user a message went out when no provider exists would
// be worse than the missing feature.
class LogTransport implements EmailTransport {
  readonly name = "log";

  async send(message: OutboundMessage): Promise<SendResult> {
    console.info(
      `[email:log] would send to ${message.to} — "${message.subject}" (no provider configured)`
    );
    return { outcome: "logged", providerId: `log_${randomBytes(8).toString("hex")}` };
  }
}

class ResendTransport implements EmailTransport {
  readonly name = "resend";

  constructor(private apiKey: string) {}

  async send(message: OutboundMessage): Promise<SendResult> {
    try {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: message.from,
          to: [message.to],
          ...(message.cc?.length ? { cc: message.cc } : {}),
          ...(message.replyTo ? { reply_to: message.replyTo } : {}),
          subject: message.subject,
          text: message.text,
          ...(message.html ? { html: message.html } : {}),
        }),
      });

      const payload = (await response.json().catch(() => null)) as
        | { id?: string; message?: string; name?: string }
        | null;

      if (!response.ok) {
        return {
          outcome: "failed",
          error:
            payload?.message ??
            `Provider rejected the message (HTTP ${response.status}).`,
        };
      }
      return { outcome: "sent", providerId: payload?.id };
    } catch (err) {
      // Network failure, DNS, timeout — the row is still written as FAILED so
      // the message isn't silently lost.
      return {
        outcome: "failed",
        error: err instanceof Error ? err.message : "Could not reach the email provider.",
      };
    }
  }
}

function pickTransport(): EmailTransport {
  const key = process.env.RESEND_API_KEY;
  if (key) return new ResendTransport(key);
  return new LogTransport();
}

export const emailTransport: EmailTransport = pickTransport();

export function transportIsLive(): boolean {
  return emailTransport.name !== "log";
}

// --- Addresses ---------------------------------------------------------------

// Who mail appears to come from. Must be a domain the provider is allowed to
// send for; Resend rejects anything else.
export function senderAddress(): string {
  const address = process.env.EMAIL_FROM ?? "workflow@example.com";
  const name = process.env.EMAIL_FROM_NAME;
  return name ? `${name} <${address}>` : address;
}

export function firmName(): string {
  return process.env.EMAIL_FROM_NAME ?? "our office";
}

// The inbound side. Replies are addressed to <prefix>+<token>@<domain>, so the
// webhook can recover which conversation a reply belongs to from the address
// alone rather than guessing from the subject line. Requires a catch-all
// inbound route on that domain at the provider.
const INBOUND_PREFIX = () => process.env.EMAIL_INBOUND_PREFIX ?? "reply";
const INBOUND_DOMAIN = () => process.env.EMAIL_INBOUND_DOMAIN ?? null;

export function inboundConfigured(): boolean {
  return INBOUND_DOMAIN() !== null;
}

export function newReplyToken(): string {
  return randomBytes(12).toString("hex");
}

// The Reply-To we put on an outbound message. Null when no inbound domain is
// configured — then replies simply go to the sender's own mailbox, which is a
// perfectly reasonable degraded mode.
export function replyToAddress(token: string): string | null {
  const domain = INBOUND_DOMAIN();
  if (!domain) return null;
  return `${INBOUND_PREFIX()}+${token}@${domain}`;
}

// Pulls our token back out of whatever the provider reports as the recipient.
// Tolerant on purpose: providers variously hand over "Name <a+b@c>", a bare
// address, or a list. Anything that isn't ours returns null and the caller
// falls back to matching on the sender.
export function extractReplyToken(recipients: string | string[] | null | undefined): string | null {
  if (!recipients) return null;
  const list = Array.isArray(recipients) ? recipients : [recipients];
  const prefix = INBOUND_PREFIX();
  for (const raw of list) {
    for (const address of parseAddressList(raw)) {
      const [local] = address.split("@");
      if (!local) continue;
      const plus = local.indexOf("+");
      if (plus === -1) continue;
      if (local.slice(0, plus) !== prefix) continue;
      const token = local.slice(plus + 1).trim();
      if (token) return token;
    }
  }
  return null;
}

// "Alice <a@x.com>, b@y.com" → ["a@x.com", "b@y.com"]. Lowercased, since mail
// addresses are matched against stored contacts.
export function parseAddressList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((part) => {
      const angled = part.match(/<([^>]+)>/);
      return (angled ? angled[1] : part).trim().toLowerCase();
    })
    .filter((a) => a.includes("@"));
}

export function displayName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const angled = raw.match(/^\s*"?([^"<]*?)"?\s*</);
  const name = angled?.[1]?.trim();
  return name && name.length > 0 ? name : null;
}

export function isValidAddress(address: string): boolean {
  // Deliberately loose — enough to catch a typo, not a spec implementation.
  return /^[^\s@,]+@[^\s@,]+\.[^\s@,]{2,}$/.test(address.trim());
}

// --- Threading ---------------------------------------------------------------

// A conversation id. Engagement-scoped when we have one so every message about
// August's bookkeeping for a client groups together; otherwise client-scoped.
export function threadKeyFor(input: {
  clientId?: string | null;
  projectId?: string | null;
  periodName?: string | null;
}): string {
  if (input.clientId && input.projectId) {
    return `eng:${input.clientId}:${input.projectId}:${input.periodName ?? "-"}`;
  }
  if (input.clientId) return `client:${input.clientId}`;
  return `misc:${randomBytes(6).toString("hex")}`;
}

// --- Templates ---------------------------------------------------------------

// The values a template can interpolate. Everything is a string by the time it
// gets here so rendering can't fail on a null.
export type TemplateContext = Record<string, string>;

export const TEMPLATE_VARIABLES: { key: string; description: string }[] = [
  { key: "client_name", description: "The client company's name" },
  { key: "contact_first_name", description: "First name of the contact being written to" },
  { key: "project_name", description: "The service, e.g. Bookkeeping" },
  { key: "period", description: "The accounting period, e.g. 2026-09" },
  { key: "due_date", description: "The engagement's deadline for that period" },
  { key: "open_tasks", description: "How many checklist steps are still open" },
  { key: "next_task", description: "The next open step on the checklist" },
  { key: "sender_name", description: "The person sending the message" },
  { key: "firm_name", description: "Your firm's name (EMAIL_FROM_NAME)" },
];

// Replaces {{placeholder}} with its value. An unknown or empty placeholder
// collapses to "" rather than leaving {{braces}} in a message a client reads —
// the compose screen previews the rendered text, so a blank is visible before
// anything is sent.
export function renderTemplate(source: string, context: TemplateContext): string {
  return source.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_match, key: string) => {
    return context[key.toLowerCase()] ?? "";
  });
}

// Finds every placeholder a template uses, for the compose screen's "this
// template needs…" hint.
export function templateVariables(source: string): string[] {
  const found = new Set<string>();
  for (const match of source.matchAll(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi)) {
    found.add(match[1].toLowerCase());
  }
  return [...found];
}

// Plain text → a minimal HTML body. No styling framework, no remote assets:
// mail clients mangle those, and this keeps the HTML part faithful to the text
// part (which matters for spam scoring).
export function textToHtml(text: string): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const paragraphs = escaped
    .split(/\n{2,}/)
    .map((block) => `<p style="margin:0 0 1em">${block.replace(/\n/g, "<br />")}</p>`)
    .join("");
  return `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:14px;line-height:1.5;color:#1a1a1a">${paragraphs}</div>`;
}

// Strips a quoted reply chain off inbound text so the thread view shows what
// the person actually wrote. Conservative: only the universally safe markers.
export function stripQuotedReply(text: string): string {
  const lines = text.split("\n");
  const cut = lines.findIndex(
    (line) =>
      /^>/.test(line.trim()) ||
      /^On .+ wrote:$/.test(line.trim()) ||
      /^-{2,}\s*Original Message\s*-{2,}$/i.test(line.trim()) ||
      /^_{10,}$/.test(line.trim())
  );
  const body = cut === -1 ? text : lines.slice(0, cut).join("\n");
  return body.trim() || text.trim();
}

// --- Inbound webhook verification --------------------------------------------

// Verifies a webhook signature. Supports two schemes so this works behind more
// than one provider:
//
//   1. Svix headers (svix-id / svix-timestamp / svix-signature), which is what
//      Resend uses. Signed content is "<id>.<timestamp>.<body>", HMAC-SHA256
//      with the base64 secret after the "whsec_" prefix, compared against any
//      of the space-separated "v1,<sig>" values.
//   2. A plain "x-webhook-signature: <hex hmac of the raw body>" for anything
//      else, and a bare bearer token as a last resort.
//
// Returns false when EMAIL_INBOUND_SECRET is unset — an unauthenticated public
// endpoint that writes rows is not an acceptable default.
export function verifyInboundSignature(
  rawBody: string,
  headers: Headers
): { ok: boolean; reason?: string } {
  const secret = process.env.EMAIL_INBOUND_SECRET;
  if (!secret) {
    return { ok: false, reason: "EMAIL_INBOUND_SECRET is not configured." };
  }

  const svixId = headers.get("svix-id") ?? headers.get("webhook-id");
  const svixTimestamp = headers.get("svix-timestamp") ?? headers.get("webhook-timestamp");
  const svixSignature = headers.get("svix-signature") ?? headers.get("webhook-signature");

  if (svixId && svixTimestamp && svixSignature) {
    // Reject anything more than five minutes old, so a captured request can't
    // be replayed indefinitely.
    const age = Math.abs(Date.now() / 1000 - Number(svixTimestamp));
    if (!Number.isFinite(age) || age > 300) {
      return { ok: false, reason: "Webhook timestamp is outside the accepted window." };
    }
    const key = secret.startsWith("whsec_")
      ? Buffer.from(secret.slice(6), "base64")
      : Buffer.from(secret, "utf8");
    const expected = createHmac("sha256", key)
      .update(`${svixId}.${svixTimestamp}.${rawBody}`)
      .digest("base64");
    const provided = svixSignature
      .split(" ")
      .map((part) => (part.includes(",") ? part.split(",")[1] : part));
    const match = provided.some((candidate) => constantTimeEquals(candidate, expected));
    return match ? { ok: true } : { ok: false, reason: "Signature did not match." };
  }

  const plain = headers.get("x-webhook-signature");
  if (plain) {
    const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
    return constantTimeEquals(plain.replace(/^sha256=/, ""), expected)
      ? { ok: true }
      : { ok: false, reason: "Signature did not match." };
  }

  const auth = headers.get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) {
    return constantTimeEquals(auth.slice(7).trim(), secret)
      ? { ok: true }
      : { ok: false, reason: "Bearer token did not match." };
  }

  return { ok: false, reason: "No signature header present." };
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// --- Inbound payload parsing --------------------------------------------------

export type ParsedInbound = {
  from: string;
  fromName: string | null;
  to: string[];
  subject: string;
  text: string;
  html: string | null;
  providerId: string | null;
  // Resend's `email.received` webhook carries metadata ONLY — no body. When
  // that's what arrived, this is the id the body has to be fetched with.
  // See fetchReceivedEmail below.
  emailId: string | null;
};

// Providers disagree about inbound payload shape, and this app can't be tested
// against all of them, so the parser reads the union of the common spellings
// rather than committing to one vendor's envelope. Anything it can't find a
// sender or recipient in is rejected by the caller.
export function parseInboundPayload(payload: unknown): ParsedInbound | null {
  if (!payload || typeof payload !== "object") return null;
  const root = payload as Record<string, unknown>;
  // Webhook envelopes usually wrap the message in `data`.
  const data = (root.data && typeof root.data === "object" ? root.data : root) as Record<
    string,
    unknown
  >;

  const str = (...keys: string[]): string | null => {
    for (const key of keys) {
      const value = data[key] ?? root[key];
      if (typeof value === "string" && value.trim()) return value;
    }
    return null;
  };

  const list = (...keys: string[]): string[] => {
    for (const key of keys) {
      const value = data[key] ?? root[key];
      if (typeof value === "string") return parseAddressList(value);
      if (Array.isArray(value)) {
        return value.flatMap((entry) =>
          typeof entry === "string"
            ? parseAddressList(entry)
            : entry && typeof entry === "object" && typeof (entry as { address?: unknown }).address === "string"
            ? parseAddressList((entry as { address: string }).address)
            : []
        );
      }
    }
    return [];
  };

  const rawFrom = str("from", "sender", "From");
  const fromAddresses = parseAddressList(rawFrom);
  const from = fromAddresses[0] ?? null;
  const to = [...list("to", "To", "recipient", "recipients", "envelope_to")];

  if (!from) return null;

  return {
    from,
    fromName: displayName(rawFrom),
    to,
    subject: str("subject", "Subject") ?? "(no subject)",
    text: str("text", "text_body", "plain", "body_plain", "TextBody") ?? "",
    html: str("html", "html_body", "body_html", "HtmlBody"),
    providerId: str("message_id", "messageId", "id", "MessageID"),
    emailId: str("email_id", "emailId"),
  };
}

// Fetches a received message's body from Resend.
//
// Their `email.received` webhook is metadata only — sender, recipients,
// subject, attachment list — and the body has to be pulled separately with the
// id the webhook carried. Without this step every inbound reply would be
// stored blank.
//
//   GET https://api.resend.com/emails/receiving/{id}
//
// Returns null when there's no API key, or on any failure: the caller still
// stores the message from the webhook metadata, so a reply is never lost just
// because the follow-up call didn't land.
export async function fetchReceivedEmail(emailId: string): Promise<{
  text: string | null;
  html: string | null;
  to: string[];
  cc: string[];
  subject: string | null;
  messageId: string | null;
} | null> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return null;

  try {
    const response = await fetch(
      `https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}`,
      { headers: { Authorization: `Bearer ${apiKey}` } }
    );
    if (!response.ok) return null;

    const body = (await response.json()) as Record<string, unknown>;
    const addresses = (value: unknown): string[] =>
      Array.isArray(value)
        ? value.flatMap((v) => (typeof v === "string" ? parseAddressList(v) : []))
        : typeof value === "string"
        ? parseAddressList(value)
        : [];

    return {
      text: typeof body.text === "string" ? body.text : null,
      html: typeof body.html === "string" ? body.html : null,
      to: addresses(body.to),
      cc: addresses(body.cc),
      subject: typeof body.subject === "string" ? body.subject : null,
      messageId: typeof body.message_id === "string" ? body.message_id : null,
    };
  } catch {
    return null;
  }
}
