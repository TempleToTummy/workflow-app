import type { Metadata } from "next";
import { findRequestByToken } from "@/lib/client-request-data";
import { recordRequestView } from "@/lib/client-request-actions";
import { firmName } from "@/lib/email";
import { REQUEST_TTL_LABEL, ALLOWED_UPLOAD_EXTENSIONS, MAX_UPLOAD_BYTES } from "@/lib/client-requests";
import { ClientRequestForm } from "@/components/client-request-form";
import { formatDate } from "@/lib/dates";

// The client-facing page. No session, no account, no portal — the 256-bit
// token in the URL is the whole credential, and this page is the only thing it
// opens.
//
// Everything about it is scoped to one request on purpose. It never renders a
// list, never links into the app, and reads a deliberately narrow projection
// (PublicRequest in src/lib/client-request-data.ts) rather than the row plus
// its relations, so it is structurally incapable of showing another client's
// work even if somebody later adds a field carelessly.
//
// It is registered in src/proxy.ts PUBLIC_PREFIXES; the actions behind it do
// their own token check, rate limiting and expiry enforcement on every call,
// because rendering this page is not permission to act on it later.

// No indexing, ever. A request link that turned up in a search result would be
// a data breach with a URL.
export const metadata: Metadata = {
  title: "A request from your accountants",
  robots: { index: false, follow: false, nocache: true },
};

export default async function ClientRequestPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const request = await findRequestByToken(token);

  // One identical page for a token that never existed and one that isn't
  // valid, so this route can't be used to confirm which tokens are real.
  if (!request) return <Unavailable firm={firmName()} />;

  // Best-effort and awaited: it's one indexed update, and the count is what
  // answers "have they even looked at it" before somebody picks up the phone.
  await recordRequestView(token);

  if (request.block) {
    return (
      <Unavailable
        firm={firmName()}
        heading={
          request.block === "completed"
            ? "All done — thank you"
            : request.block === "cancelled"
              ? "This request was withdrawn"
              : "This link has expired"
        }
        body={
          request.block === "completed"
            ? request.kind === "APPROVAL" && request.approved !== null
              ? `You ${request.approved ? "approved this" : "asked for changes"} on ${
                  request.respondedAt ? formatDate(request.respondedAt) : "an earlier visit"
                }. There's nothing else to do.`
              : "We've received what we needed. There's nothing else to do."
            : request.block === "cancelled"
              ? "Your accountants withdrew this request. If you think that's a mistake, reply to the message that brought you here."
              : `Links stay open for ${REQUEST_TTL_LABEL}. Reply to the message that brought you here and we'll send a fresh one.`
        }
        tone={request.block === "completed" ? "good" : "neutral"}
      />
    );
  }

  return (
    <div className="mx-auto w-full max-w-xl px-6 py-12">
      <header>
        <p className="text-xs tracking-wide text-ink-muted uppercase">{firmName()}</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-ink">
          {request.kind === "UPLOAD" ? "We need a document from you" : "We need your approval"}
        </h1>
        <p className="mt-1 text-sm text-ink-muted">
          For {request.clientName} · {request.projectName}
          {request.periodName && <> · {request.periodName}</>}
        </p>
      </header>

      <div className="mt-6 rounded-lg border border-line bg-surface p-5">
        <h2 className="font-medium text-ink">{request.title}</h2>
        {request.message && (
          <p className="mt-2 text-sm whitespace-pre-wrap text-ink-muted">{request.message}</p>
        )}

        {request.uploaded.length > 0 && (
          <div className="mt-4 rounded-md border border-[var(--status-done)]/30 bg-[var(--status-done-soft)] px-3 py-2">
            <p className="text-xs font-medium text-[var(--status-done)]">
              Received so far
            </p>
            <ul className="mt-1 flex flex-col gap-0.5">
              {request.uploaded.map((doc) => (
                <li key={doc.id} className="text-xs text-[var(--status-done)]">
                  {/* Filename only, with no download link: this page hands
                      things TO the firm. Serving the bytes back out would mean
                      anyone holding the link could read the client's
                      documents, which is a bigger promise than we need to
                      make. */}
                  {doc.filename} · {formatDate(doc.createdAt)}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="mt-5">
          <ClientRequestForm
            token={token}
            kind={request.kind}
            accept={ALLOWED_UPLOAD_EXTENSIONS.map((e) => `.${e}`).join(",")}
            maxBytes={MAX_UPLOAD_BYTES}
            alreadySent={request.uploaded.length}
          />
        </div>
      </div>

      <p className="mt-4 text-center text-xs text-ink-muted">
        This link is personal to this request and expires on{" "}
        {formatDate(request.expiresAt)}. Please don&apos;t forward it.
      </p>
    </div>
  );
}

function Unavailable({
  firm,
  heading = "This link is no longer available",
  body = "It may have expired, or been replaced by a newer one. Reply to the message that brought you here and we'll send a fresh link.",
  tone = "neutral",
}: {
  firm: string;
  heading?: string;
  body?: string;
  tone?: "neutral" | "good";
}) {
  return (
    <div className="mx-auto w-full max-w-xl px-6 py-16">
      <p className="text-xs tracking-wide text-ink-muted uppercase">{firm}</p>
      <div
        className={`mt-3 rounded-lg border p-6 ${
          tone === "good"
            ? "border-[var(--status-done)]/30 bg-[var(--status-done-soft)]"
            : "border-line bg-surface"
        }`}
      >
        <h1
          className={`text-lg font-semibold tracking-tight ${
            tone === "good" ? "text-[var(--status-done)]" : "text-ink"
          }`}
        >
          {heading}
        </h1>
        <p className={`mt-2 text-sm ${tone === "good" ? "text-[var(--status-done)]" : "text-ink-muted"}`}>
          {body}
        </p>
      </div>
    </div>
  );
}
