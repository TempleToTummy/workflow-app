import { prisma } from "@/lib/prisma";
import { hashToken } from "@/lib/password";
import { blockReason, type RequestBlock } from "@/lib/client-requests";

// Reads for client-facing requests. Not a "use server" module: the staff-side
// queries are called from server components, and the public lookup below must
// never be exposed as a POST endpoint that anyone could call with a guessed
// token.

// --- The public lookup -------------------------------------------------------

// What the tokenized page is allowed to know. Deliberately a narrow projection
// rather than the request row plus its relations: whoever holds this link is
// outside the firm, and the page should be incapable of rendering a field it
// was never meant to show. No employee names, no other periods, no other
// engagements, no internal notes.
export type PublicRequest = {
  id: string;
  kind: "UPLOAD" | "APPROVAL";
  title: string;
  message: string | null;
  clientName: string;
  projectName: string;
  periodName: string | null;
  // The firm's own name, so the page identifies who is asking.
  expiresAt: Date;
  // Null when the link is usable; otherwise why it isn't.
  block: RequestBlock | null;
  // Files the client has already sent through this link, so a second visit
  // shows what arrived rather than looking like nothing happened.
  uploaded: { id: string; filename: string; createdAt: Date }[];
  respondedAt: Date | null;
  approved: boolean | null;
};

// Resolves a raw token to a request. Returns null for anything that doesn't
// match, with no distinction between "never existed" and "belongs to someone
// else" — the page renders one identical not-found for every failure, so the
// endpoint can't be used to confirm that a token is real.
export async function findRequestByToken(token: string): Promise<PublicRequest | null> {
  // A token is 64 hex characters. Checking the shape first means a junk URL
  // costs no database round trip at all, which is most of what a scanner
  // sends.
  if (!/^[0-9a-f]{64}$/.test(token)) return null;

  const request = await prisma.clientRequest.findUnique({
    where: { tokenHash: hashToken(token) },
    include: {
      client: { select: { companyName: true } },
      project: { select: { name: true } },
      documents: {
        select: { id: true, filename: true, createdAt: true },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!request) return null;

  return {
    id: request.id,
    kind: request.kind,
    title: request.title,
    message: request.message,
    clientName: request.client.companyName,
    projectName: request.project.name,
    periodName: request.periodName,
    expiresAt: request.expiresAt,
    block: blockReason(request),
    uploaded: request.documents,
    respondedAt: request.completedAt,
    approved: request.approved,
  };
}

// --- Staff-side reads --------------------------------------------------------

export type StaffRequest = Awaited<ReturnType<typeof requestsForEngagement>>[number];

export async function requestsForEngagement(input: {
  clientId: string;
  projectId: string;
  periodName?: string | null;
}) {
  return prisma.clientRequest.findMany({
    where: {
      clientId: input.clientId,
      projectId: input.projectId,
      // A request raised before a rollover still belongs to its own period.
      ...(input.periodName ? { periodName: input.periodName } : {}),
    },
    include: {
      activity: { include: { subTask: { select: { name: true } } } },
      documents: { select: { id: true, filename: true, createdAt: true } },
    },
    orderBy: { createdAt: "desc" },
  });
}

// Open requests per activity, for the badge on a checklist step.
export async function openRequestsByActivity(
  activityIds: string[]
): Promise<Map<string, number>> {
  if (activityIds.length === 0) return new Map();
  const rows = await prisma.clientRequest.groupBy({
    by: ["activityId"],
    where: { activityId: { in: activityIds }, status: "OPEN" },
    _count: { _all: true },
  });
  return new Map(
    rows
      .filter((r): r is typeof r & { activityId: string } => r.activityId !== null)
      .map((r) => [r.activityId, r._count._all])
  );
}

// Everything the firm is currently waiting on a client for, newest first. The
// answer to "what's blocked on someone outside the office", which before this
// existed nowhere at all.
export async function waitingOnClients(input?: { clientId?: string | null; take?: number }) {
  return prisma.clientRequest.findMany({
    where: {
      status: "OPEN",
      ...(input?.clientId ? { clientId: input.clientId } : {}),
    },
    include: {
      client: { select: { id: true, companyName: true } },
      project: { select: { id: true, name: true } },
      activity: { include: { subTask: { select: { name: true } } } },
      documents: { select: { id: true } },
    },
    orderBy: [{ createdAt: "desc" }],
    take: input?.take ?? 100,
  });
}

// The best address to send a request link to: a named contact first, falling
// back to the client record's own address. Returns null when neither exists —
// the UI then offers the copyable link instead of pretending it can mail it.
export async function bestContactFor(clientId: string): Promise<{
  email: string;
  name: string | null;
} | null> {
  const contact = await prisma.corpContact.findFirst({
    where: { clientId, email: { not: null } },
    orderBy: { createdAt: "asc" },
  });
  if (contact?.email) {
    const name = [contact.firstName, contact.lastName].filter(Boolean).join(" ").trim();
    return { email: contact.email, name: name || null };
  }
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { email: true, companyName: true },
  });
  if (client?.email) return { email: client.email, name: client.companyName };
  return null;
}
