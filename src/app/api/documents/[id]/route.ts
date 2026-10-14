import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { canAccessEngagement } from "@/lib/access";
import { readDocumentBytes, LegacyPlaintextError } from "@/lib/document-vault";
import { IntegrityError } from "@/lib/encryption";
import { mimeTypeFor } from "@/lib/file-safety";
import { recordAudit, actorFrom, AUDIT } from "@/lib/audit";
import { rateLimit } from "@/lib/rate-limit";

// Serves a stored Document: authorize, decrypt, log, deliver.
//
//   * Access: same gate as the Files tab the link came from — an employee can
//     download only from an engagement they're assigned to. "Not found" either
//     way, so the route can't confirm which document ids exist.
//   * Rate limit: 120 downloads per 10 minutes per person. Real use never gets
//     near it; a compromised session scripting its way through every client's
//     files does, and gets stopped (and the attempt is still in the log).
//   * Every download is an audit row: who took which client's file, when.
//   * The response can never be rendered or cached: always an attachment,
//     nosniff, a sandboxing CSP, and no-store. The content type comes from the
//     file-type allow-list, not from anything the uploader sent.

const DOWNLOAD_LIMIT = { limit: 120, windowMs: 10 * 60_000 };

const LOCKED_DOWN_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; sandbox",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
};

function plain(body: string, status: number, extra: Record<string, string> = {}) {
  return new Response(body, { status, headers: { ...LOCKED_DOWN_HEADERS, "Content-Type": "text/plain; charset=utf-8", ...extra } });
}

// RFC 6266 / 5987: an ASCII fallback for old clients plus the exact UTF-8 name.
function contentDisposition(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getCurrentUser();
  if (!user) return plain("Unauthorized", 401);

  const { id } = await params;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return plain("Not found", 404);

  const limit = rateLimit(`download:${user.id}`, DOWNLOAD_LIMIT);
  if (!limit.ok) {
    return plain("Too many downloads in a short time. Try again shortly.", 429, {
      "Retry-After": String(limit.retryAfterSeconds),
    });
  }

  const doc = await prisma.document.findUnique({
    where: { id },
    include: { client: { select: { companyName: true } } },
  });
  if (!doc || !(await canAccessEngagement(user, doc.clientId, doc.projectId, doc.instance))) {
    return plain("Not found", 404);
  }

  let bytes: Buffer;
  try {
    bytes = await readDocumentBytes(doc);
  } catch (err) {
    if (err instanceof LegacyPlaintextError) return plain(err.message, 409);
    if (err instanceof IntegrityError) {
      // Tampered with, truncated, or swapped for another file. Never serve it.
      console.error(`[documents] integrity check failed for document ${doc.id}`);
      return plain("This file failed its integrity check and can't be served. An admin has been notified in the server log.", 500);
    }
    console.error(`[documents] couldn't read document ${doc.id}`, err);
    return plain("File is missing from storage", 410);
  }

  await recordAudit({
    entityType: "Document",
    entityId: doc.id,
    action: AUDIT.DOCUMENT_DOWNLOADED,
    summary: `Downloaded "${doc.filename}"`,
    clientId: doc.clientId,
    projectId: doc.projectId,
    periodName: doc.periodName,
    contextLabel: doc.client.companyName,
    actor: actorFrom(user),
  });

  return new Response(new Uint8Array(bytes), {
    headers: {
      ...LOCKED_DOWN_HEADERS,
      "Content-Type": mimeTypeFor(doc.filename),
      "Content-Length": String(bytes.length),
      "Content-Disposition": contentDisposition(doc.filename),
    },
  });
}
