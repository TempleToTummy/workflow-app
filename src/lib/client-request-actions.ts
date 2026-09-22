"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { newToken, hashToken } from "@/lib/password";
import { recordAudit, actorFrom, AUDIT } from "@/lib/audit";
import { objectStore, documentStorageKey, DEFAULT_BUCKET } from "@/lib/storage";
import { rateLimit } from "@/lib/rate-limit";
import { sendSystemEmail } from "@/lib/system-email";
import { firmName } from "@/lib/email";
import { bestContactFor } from "@/lib/client-request-data";
import {
  checkUpload,
  isActionable,
  requestExpiry,
  requestUrl,
  statusAfterResponse,
  REQUEST_TTL_LABEL,
} from "@/lib/client-requests";

// Client-facing requests: a tokenized link that lets a client do the one thing
// the workflow is waiting on them for.
//
// This module has two halves with completely different trust models, and the
// split is the most important thing about it:
//
//   STAFF ACTIONS (createClientRequest, revokeClientRequest,
//   resendClientRequest) require a signed-in employee, like every other action
//   in the app.
//
//   PUBLIC ACTIONS (submitRequestUpload, submitRequestDecision,
//   recordRequestView) are callable by anyone holding a link — they are how the
//   page works, so they CANNOT require a session. Every one of them therefore:
//     - takes the raw token and nothing else that identifies the engagement.
//       A clientId or activityId from the caller would let anybody write to any
//       client by editing the request payload; instead every id is read back
//       from the token's own row.
//     - re-checks status and expiry on each call. Rendering the page is not
//       permission to act on it later.
//     - is rate limited per token, so a link can't be used to hammer the app.
//     - refuses to leak whether a token exists: one identical error for a bad
//       token, an expired one and a revoked one.

const REQUEST_ACTION_LIMIT = { limit: 30, windowMs: 15 * 60_000 };
const REQUEST_VIEW_LIMIT = { limit: 60, windowMs: 15 * 60_000 };

// The single message every public failure returns. Saying "this link expired"
// versus "no such link" would confirm to a scanner which tokens are real.
const OPAQUE_FAILURE = "This link is no longer available. Please ask us for a new one.";

function revalidateRequest(clientId: string, projectId: string) {
  revalidatePath(`/assignments/${clientId}/${projectId}`);
  revalidatePath(`/clients/${clientId}`);
  revalidatePath("/requests");
  revalidatePath("/activity");
}

// --- Staff side ---------------------------------------------------------------

export type CreateRequestInput = {
  clientId: string;
  projectId: string;
  periodName?: string | null;
  // The checklist step this unblocks. Optional: a request can be raised
  // against the engagement generally.
  activityId?: string | null;
  kind: "UPLOAD" | "APPROVAL";
  title: string;
  message?: string | null;
  // When true, the link is mailed to the client's best contact address as well
  // as returned. With no mail provider configured the message is recorded and
  // not delivered (see src/lib/email.ts), which is exactly why the link is
  // always returned for copying.
  email?: boolean;
};

export type CreateRequestResult = {
  id: string;
  // The RAW token, returned exactly once. It is never stored and can't be
  // recovered later — the same rule as an invite or a reset link.
  url: string;
  emailed: { to: string; delivered: boolean } | null;
};

export async function createClientRequest(
  input: CreateRequestInput
): Promise<CreateRequestResult> {
  const user = await requireUser();

  const title = input.title.trim();
  if (!title) throw new Error("Say what you're asking the client for.");
  if (title.length > 200) throw new Error("That title is too long.");

  // Read the engagement rather than trusting the ids: this also confirms the
  // client and project actually go together.
  const assignment = await prisma.projectClientMap.findUniqueOrThrow({
    where: { clientId_projectId: { clientId: input.clientId, projectId: input.projectId } },
    include: { client: true, project: true },
  });

  // An activity, when given, must belong to this engagement.
  let activityId: string | null = null;
  let stepName: string | null = null;
  if (input.activityId) {
    const activity = await prisma.clientActivity.findUnique({
      where: { id: input.activityId },
      include: { subTask: { select: { name: true } } },
    });
    if (
      !activity ||
      activity.clientId !== input.clientId ||
      activity.projectId !== input.projectId
    ) {
      throw new Error("That task isn't part of this engagement.");
    }
    activityId = activity.id;
    stepName = activity.subTask.name;
  }

  const token = newToken();
  const createdByLabel = `${user.firstName} ${user.lastName}`;

  const request = await prisma.clientRequest.create({
    data: {
      clientId: input.clientId,
      projectId: input.projectId,
      periodName: input.periodName?.trim() || assignment.currentPeriod,
      activityId,
      kind: input.kind,
      title,
      message: input.message?.trim() || null,
      tokenHash: hashToken(token),
      expiresAt: requestExpiry(),
      createdById: user.id,
      createdByLabel,
    },
  });

  const url = requestUrl(await appBaseUrl(), token);

  await recordAudit({
    entityType: "ClientRequest",
    entityId: request.id,
    action: AUDIT.REQUEST_CREATED,
    summary: `Asked ${assignment.client.companyName} to ${
      input.kind === "UPLOAD" ? "send documents" : "approve"
    }: ${title}${stepName ? ` (${stepName})` : ""}`,
    toValue: input.kind,
    clientId: input.clientId,
    projectId: input.projectId,
    periodName: request.periodName,
    contextLabel: `${assignment.client.companyName} · ${assignment.project.name}`,
    actor: actorFrom(user),
  });

  let emailed: CreateRequestResult["emailed"] = null;
  if (input.email) {
    emailed = await mailRequestLink({
      clientId: input.clientId,
      title,
      message: request.message,
      kind: input.kind,
      url,
    });
  }

  revalidateRequest(input.clientId, input.projectId);
  return { id: request.id, url, emailed };
}

// Issues a FRESH token for an existing request and invalidates the old one.
// This is "resend" rather than "show me the link again", because the raw token
// was never stored — and re-issuing is the safer primitive anyway: a link
// forwarded to the wrong person stops working the moment a new one is minted.
export async function resendClientRequest(
  requestId: string,
  options?: { email?: boolean }
): Promise<CreateRequestResult> {
  const user = await requireUser();
  const before = await prisma.clientRequest.findUniqueOrThrow({
    where: { id: requestId },
    include: { client: { select: { companyName: true } }, project: { select: { name: true } } },
  });
  if (before.status === "CANCELLED") {
    throw new Error("This request was revoked. Raise a new one instead.");
  }

  const token = newToken();
  await prisma.clientRequest.update({
    where: { id: requestId },
    data: {
      tokenHash: hashToken(token),
      expiresAt: requestExpiry(),
      // Re-opening a completed upload request is a deliberate "we need more
      // documents" rather than a new ask, so the history stays on one row.
      status: "OPEN",
    },
  });

  const url = requestUrl(await appBaseUrl(), token);

  await recordAudit({
    entityType: "ClientRequest",
    entityId: requestId,
    action: AUDIT.REQUEST_CREATED,
    summary: `Re-issued the link for "${before.title}" — the previous link stopped working`,
    clientId: before.clientId,
    projectId: before.projectId,
    periodName: before.periodName,
    contextLabel: `${before.client.companyName} · ${before.project.name}`,
    actor: actorFrom(user),
  });

  const emailed = options?.email
    ? await mailRequestLink({
        clientId: before.clientId,
        title: before.title,
        message: before.message,
        kind: before.kind,
        url,
      })
    : null;

  revalidateRequest(before.clientId, before.projectId);
  return { id: requestId, url, emailed };
}

export async function revokeClientRequest(requestId: string): Promise<void> {
  const user = await requireUser();
  const before = await prisma.clientRequest.findUniqueOrThrow({
    where: { id: requestId },
    include: { client: { select: { companyName: true } }, project: { select: { name: true } } },
  });
  if (before.status === "CANCELLED") return;

  await prisma.clientRequest.update({
    where: { id: requestId },
    data: { status: "CANCELLED" },
  });

  await recordAudit({
    entityType: "ClientRequest",
    entityId: requestId,
    action: AUDIT.REQUEST_REVOKED,
    summary: `Revoked the client link for "${before.title}"`,
    clientId: before.clientId,
    projectId: before.projectId,
    periodName: before.periodName,
    contextLabel: `${before.client.companyName} · ${before.project.name}`,
    actor: actorFrom(user),
  });

  revalidateRequest(before.clientId, before.projectId);
}

// --- Public side --------------------------------------------------------------

// Resolves a token to the row, applying every gate. Throws the one opaque
// error for all failures. Internal: nothing exported takes an id.
async function resolveActionable(token: string, limitKey: string) {
  const limit = rateLimit(`request:${limitKey}:${hashToken(token).slice(0, 16)}`, REQUEST_ACTION_LIMIT);
  if (!limit.ok) {
    throw new Error("Too many attempts. Please wait a few minutes and try again.");
  }
  if (!/^[0-9a-f]{64}$/.test(token)) throw new Error(OPAQUE_FAILURE);

  const request = await prisma.clientRequest.findUnique({
    where: { tokenHash: hashToken(token) },
    include: {
      client: { select: { companyName: true } },
      project: { select: { name: true } },
      activity: { include: { subTask: { select: { name: true } } } },
    },
  });
  if (!request) throw new Error(OPAQUE_FAILURE);
  if (!isActionable(request)) throw new Error(OPAQUE_FAILURE);
  return request;
}

// Counts a page view. Best-effort: a failure here must never stop the page
// rendering, because the whole point is that the client can act.
export async function recordRequestView(token: string): Promise<void> {
  try {
    if (!/^[0-9a-f]{64}$/.test(token)) return;
    const key = hashToken(token);
    const limit = rateLimit(`request:view:${key.slice(0, 16)}`, REQUEST_VIEW_LIMIT);
    if (!limit.ok) return;

    const request = await prisma.clientRequest.findUnique({
      where: { tokenHash: key },
      select: { id: true, clientId: true, projectId: true, periodName: true, viewCount: true, title: true },
    });
    if (!request) return;

    await prisma.clientRequest.update({
      where: { id: request.id },
      data: { viewCount: { increment: 1 }, lastViewedAt: new Date() },
    });

    // Only the FIRST open is audited. "Did they even look at it" is answered
    // by one row; a row per refresh would bury the rest of the log.
    if (request.viewCount === 0) {
      await recordAudit({
        entityType: "ClientRequest",
        entityId: request.id,
        action: AUDIT.REQUEST_VIEWED,
        summary: `Client opened the link for "${request.title}"`,
        clientId: request.clientId,
        projectId: request.projectId,
        periodName: request.periodName,
        // No signed-in actor: the client is not a user of this app.
        actor: { id: null, label: "Client (via link)" },
      });
    }
  } catch (err) {
    console.error("[client-request] failed to record a view", err);
  }
}

export type UploadResult = { filename: string; remaining: string | null };

// The client sending us a document. Mirrors uploadDocument in actions.ts —
// bytes to the ObjectStore first, then the row, so a failure can never leave a
// Document pointing at nothing — with the allow-list and size cap from
// src/lib/client-requests.ts applied on top.
export async function submitRequestUpload(formData: FormData): Promise<UploadResult> {
  const token = String(formData.get("token") ?? "");
  const request = await resolveActionable(token, "upload");
  if (request.kind !== "UPLOAD") throw new Error(OPAQUE_FAILURE);

  const file = formData.get("file");
  if (!(file instanceof File)) throw new Error("Choose a file to send.");

  const verdict = checkUpload({ name: file.name, size: file.size });
  if (!verdict.ok) throw new Error(verdict.reason);

  const responderName = String(formData.get("name") ?? "").trim().slice(0, 120) || null;
  const note = String(formData.get("note") ?? "").trim().slice(0, 2000) || null;

  const id = randomUUID();
  const storageKey = documentStorageKey(request.clientId, request.projectId, id, file.name);
  const mimeType = file.type || "application/octet-stream";
  const bytes = Buffer.from(await file.arrayBuffer());

  await objectStore.put(DEFAULT_BUCKET, storageKey, bytes, mimeType);
  try {
    await prisma.document.create({
      data: {
        id,
        clientId: request.clientId,
        projectId: request.projectId,
        // The period comes from the request, so the file lands in the right
        // period's Files tab even if the engagement has since rolled forward.
        periodName: request.periodName,
        // No employee uploaded this. clientRequestId is what distinguishes
        // "the client sent it" from "nobody recorded who did".
        uploadedById: null,
        clientRequestId: request.id,
        filename: file.name,
        mimeType,
        size: file.size,
        bucket: DEFAULT_BUCKET,
        storageKey,
      },
    });
  } catch (err) {
    await objectStore.remove(DEFAULT_BUCKET, storageKey).catch(() => {});
    throw err;
  }

  await prisma.clientRequest.update({
    where: { id: request.id },
    data: {
      // An upload request stays OPEN so a client can send the rest of the
      // documents without asking for a new link (see statusAfterResponse).
      status: statusAfterResponse(request.kind),
      completedAt: request.completedAt ?? new Date(),
      respondedByName: responderName ?? request.respondedByName,
      responseNote: note ?? request.responseNote,
    },
  });

  await recordAudit({
    entityType: "ClientRequest",
    entityId: request.id,
    action: AUDIT.REQUEST_RESPONDED,
    summary: `${request.client.companyName} sent "${file.name}" for ${
      request.activity?.subTask.name ?? request.title
    }`,
    toValue: file.name,
    clientId: request.clientId,
    projectId: request.projectId,
    periodName: request.periodName,
    contextLabel: `${request.client.companyName} · ${request.project.name}`,
    actor: { id: null, label: responderName ? `${responderName} (client)` : "Client (via link)" },
  });

  // Post the arrival into the task's discussion, so the person waiting sees it
  // where they are already looking rather than having to check the Files tab.
  // Deliberately NOT marking the step done: a client's upload must not satisfy
  // the sequential-completion rule or a reviewer sign-off.
  if (request.activityId) {
    await prisma.taskComment.create({
      data: {
        activityId: request.activityId,
        authorId: null,
        authorLabel: responderName ? `${responderName} (client)` : "Client",
        body: `Sent **${file.name}** through the request link.${note ? `\n\n${note}` : ""}`,
      },
    });
  }

  revalidateRequest(request.clientId, request.projectId);
  return { filename: file.name, remaining: null };
}

export async function submitRequestDecision(input: {
  token: string;
  approved: boolean;
  name?: string | null;
  note?: string | null;
}): Promise<{ approved: boolean }> {
  const request = await resolveActionable(input.token, "decision");
  if (request.kind !== "APPROVAL") throw new Error(OPAQUE_FAILURE);

  const responderName = input.name?.trim().slice(0, 120) || null;
  const note = input.note?.trim().slice(0, 2000) || null;

  // Asking for changes without saying what they are wastes another round trip,
  // so the note is required in that direction only.
  if (!input.approved && !note) {
    throw new Error("Please tell us what needs changing.");
  }

  await prisma.clientRequest.update({
    where: { id: request.id },
    data: {
      status: statusAfterResponse(request.kind),
      approved: input.approved,
      completedAt: new Date(),
      respondedByName: responderName,
      responseNote: note,
    },
  });

  await recordAudit({
    entityType: "ClientRequest",
    entityId: request.id,
    action: AUDIT.REQUEST_RESPONDED,
    summary: `${request.client.companyName} ${
      input.approved ? "approved" : "requested changes to"
    } "${request.title}"${responderName ? ` (${responderName})` : ""}`,
    toValue: input.approved ? "approved" : "changes-requested",
    clientId: request.clientId,
    projectId: request.projectId,
    periodName: request.periodName,
    contextLabel: `${request.client.companyName} · ${request.project.name}`,
    actor: { id: null, label: responderName ? `${responderName} (client)` : "Client (via link)" },
  });

  if (request.activityId) {
    await prisma.taskComment.create({
      data: {
        activityId: request.activityId,
        authorId: null,
        authorLabel: responderName ? `${responderName} (client)` : "Client",
        body: input.approved
          ? `Approved via the request link.${note ? `\n\n${note}` : ""}`
          : `Requested changes via the request link.\n\n${note}`,
      },
    });
  }

  revalidateRequest(request.clientId, request.projectId);
  return { approved: input.approved };
}

// --- Plumbing -----------------------------------------------------------------

// The base URL for a link we're about to hand to a client. APP_URL wins, so a
// deployment behind a proxy produces correct links; otherwise the request's own
// host is used, which is what makes this work with zero configuration in
// development.
async function appBaseUrl(): Promise<string> {
  const configured = process.env.APP_URL?.trim();
  if (configured) return configured;
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

const UPLOAD_BODY = (title: string, message: string | null, url: string) => `We need a document from you.

${title}
${message ? `\n${message}\n` : ""}
Use this link to send it to us securely:

${url}

The link works for ${REQUEST_TTL_LABEL} and doesn't need a password or an account. If it has expired by the time you get to it, reply to this message and we'll send a fresh one.

${firmName()}`;

const APPROVAL_BODY = (title: string, message: string | null, url: string) => `We need your approval.

${title}
${message ? `\n${message}\n` : ""}
Use this link to approve it, or to tell us what needs changing:

${url}

The link works for ${REQUEST_TTL_LABEL} and doesn't need a password or an account. If it has expired by the time you get to it, reply to this message and we'll send a fresh one.

${firmName()}`;

// The request email. Kept in code rather than the EmailTemplate table for the
// same reason the password-reset mail is: a message whose whole purpose is to
// carry a link must not stop working because somebody edited a template, and
// {{url}} has to be filled by the system, not chosen by an author.
async function mailRequestLink(input: {
  clientId: string;
  title: string;
  message: string | null;
  kind: "UPLOAD" | "APPROVAL";
  url: string;
}): Promise<{ to: string; delivered: boolean } | null> {
  const contact = await bestContactFor(input.clientId);
  if (!contact) return null;

  const body =
    input.kind === "UPLOAD"
      ? UPLOAD_BODY(input.title, input.message, input.url)
      : APPROVAL_BODY(input.title, input.message, input.url);

  const result = await sendSystemEmail({
    to: contact.email,
    subject:
      input.kind === "UPLOAD"
        ? `Documents needed: ${input.title}`
        : `Approval needed: ${input.title}`,
    body,
    templateKey: input.kind === "UPLOAD" ? "client-request-upload" : "client-request-approval",
  });

  return { to: contact.email, delivered: result.delivered };
}
