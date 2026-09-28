// Client-facing requests: the pure rules behind the tokenized link.
//
// No next/* import and no Prisma import, so scripts/test-client-requests.ts
// can exercise the access decision directly — this is the one piece of the app
// that grants access to somebody outside the firm, so its logic being testable
// in isolation matters more here than anywhere else.
//
// Token handling reuses src/lib/password.ts (newToken + hashToken): 256 bits of
// randomness, stored only as a SHA-256 hash. Same reasoning as password reset
// — the raw token lives in the link and nowhere else, so reading the database
// is not enough to reopen a client's request.

import type { ClientRequestKind, ClientRequestStatus } from "@prisma/client";

// Two weeks. Long enough that a client who takes a holiday can still act on
// it, short enough that a link forwarded around an inbox stops working within
// a quarter. The staff can always issue a fresh one.
export const REQUEST_TTL_MS = 1000 * 60 * 60 * 24 * 14;
export const REQUEST_TTL_LABEL = "14 days";

export function requestExpiry(from: Date = new Date()): Date {
  return new Date(from.getTime() + REQUEST_TTL_MS);
}

// What the client is allowed to send us — and what staff may upload — lives in
// src/lib/file-safety.ts, which checks the bytes as well as the name. It's
// re-exported here because the request page and its tests import it from here.
export {
  ALLOWED_UPLOAD_EXTENSIONS,
  MAX_UPLOAD_BYTES,
  UPLOAD_ACCEPT,
  fileExtension,
  checkUpload,
  checkContent,
  type UploadCheck,
} from "@/lib/file-safety";

// --- The access decision -----------------------------------------------------

export type RequestState = {
  status: ClientRequestStatus;
  expiresAt: Date;
};

// Why a link isn't usable, or null when it is. Every branch is a separate
// outcome because the page says something different for each: an expired link
// invites the client to ask for a new one, a completed one reassures them that
// their document arrived, and a cancelled one says the firm withdrew it.
export type RequestBlock = "expired" | "completed" | "cancelled";

export function blockReason(
  state: RequestState,
  now: Date = new Date()
): RequestBlock | null {
  if (state.status === "CANCELLED") return "cancelled";
  if (state.status === "COMPLETED") return "completed";
  if (state.expiresAt.getTime() <= now.getTime()) return "expired";
  return null;
}

export function isActionable(state: RequestState, now: Date = new Date()): boolean {
  return blockReason(state, now) === null;
}

// An UPLOAD request stays open after a file lands: clients send bank
// statements in three messages, and closing on the first would make them
// ask for a new link twice. An APPROVAL closes on the decision — there is
// nothing further to say once they've approved or asked for changes.
export function statusAfterResponse(kind: ClientRequestKind): ClientRequestStatus {
  return kind === "APPROVAL" ? "COMPLETED" : "OPEN";
}

// How a request reads on the staff side.
export function describeRequest(input: {
  kind: ClientRequestKind;
  status: ClientRequestStatus;
  expiresAt: Date;
  approved: boolean | null;
  documentCount: number;
  now?: Date;
}): { label: string; tone: "waiting" | "good" | "warn" | "bad" } {
  const block = blockReason(input, input.now ?? new Date());

  if (input.status === "CANCELLED") return { label: "Revoked", tone: "bad" };

  if (input.kind === "APPROVAL") {
    if (input.approved === true) return { label: "Approved by client", tone: "good" };
    if (input.approved === false) return { label: "Changes requested", tone: "warn" };
  }

  if (input.kind === "UPLOAD" && input.documentCount > 0) {
    return {
      label: `${input.documentCount} file${input.documentCount === 1 ? "" : "s"} received`,
      tone: "good",
    };
  }

  if (block === "expired") return { label: "Link expired", tone: "warn" };
  if (block === "completed") return { label: "Completed", tone: "good" };
  return { label: "Waiting on client", tone: "waiting" };
}

// The checklist steps a request is normally raised against. Matched on the
// step's name because these are the firm's real, confirmed checklist steps
// (see PROJECT_NOTES.md) rather than a field somebody has to remember to set —
// which means the suggestion appears on a seeded engagement with no
// configuration at all. It is only a suggestion: any step can carry a request.
const UPLOAD_STEP_HINTS = ["document received", "documents received"];
const APPROVAL_STEP_HINTS = ["review done by client", "reviewed by client"];

export function suggestedKindForStep(stepName: string): ClientRequestKind | null {
  const name = stepName.trim().toLowerCase();
  if (UPLOAD_STEP_HINTS.includes(name)) return "UPLOAD";
  if (APPROVAL_STEP_HINTS.includes(name)) return "APPROVAL";
  return null;
}

// Default wording, so raising a request is one click on the step that needs
// it. The client's name is not interpolated here — the page already shows it,
// and repeating it in the title reads like a mail merge.
export function defaultTitle(kind: ClientRequestKind, stepName: string, periodName: string | null): string {
  const period = periodName ? ` — ${periodName}` : "";
  return kind === "UPLOAD" ? `Documents for ${stepName}${period}` : `Approval: ${stepName}${period}`;
}

// The public URL for a request. Built from the raw token, which is the only
// place it ever appears after it's minted.
export function requestUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/r/${token}`;
}
