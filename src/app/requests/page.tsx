import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { waitingOnClients } from "@/lib/client-request-data";
import { describeRequest } from "@/lib/client-requests";
import { formatDate } from "@/lib/dates";
import { ExportBar } from "@/components/export-bar";

// "What are we waiting on a client for?" — a question the app previously had
// no way to answer at all, which is how "Document Received" sits open for
// three weeks while everyone assumes somebody else chased it.
//
// Admin-only, like the reports: it is a firm-wide list of every client the
// firm is blocked on.
export default async function RequestsPage() {
  await requireAdmin();

  const requests = await waitingOnClients();
  const now = new Date();

  // Sorted so the ones that need a phone call come first: expired links, then
  // never-opened, then opened-but-not-answered, then the rest.
  const sorted = [...requests].sort((a, b) => urgency(a, now) - urgency(b, now));

  const neverOpened = requests.filter((r) => r.viewCount === 0).length;
  const expired = requests.filter((r) => r.expiresAt <= now).length;

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-10">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Waiting on clients</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Every open request for a document or an approval, and whether the client has
            opened the link.
          </p>
        </div>
        <ExportBar reportKey="client-requests" />
      </div>

      {(neverOpened > 0 || expired > 0) && (
        <div className="mt-4 flex flex-wrap gap-2 text-xs">
          {expired > 0 && (
            <span className="rounded-full bg-overdue-soft px-3 py-1 font-medium text-overdue">
              {expired} link{expired === 1 ? "" : "s"} expired — re-issue from the engagement
            </span>
          )}
          {neverOpened > 0 && (
            <span className="rounded-full bg-[var(--status-review-soft)] px-3 py-1 font-medium text-[var(--status-review)]">
              {neverOpened} never opened
            </span>
          )}
        </div>
      )}

      <div className="mt-6 overflow-hidden rounded-lg border border-line bg-surface">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-line bg-black/[0.02] text-xs tracking-wide text-ink-muted uppercase">
              <th className="px-4 py-3 font-medium">Client</th>
              <th className="px-4 py-3 font-medium">What we asked for</th>
              <th className="px-4 py-3 font-medium">Step</th>
              <th className="px-4 py-3 font-medium">State</th>
              <th className="px-4 py-3 font-medium">Asked</th>
              <th className="px-4 py-3 font-medium">Expires</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => {
              const state = describeRequest({
                kind: r.kind,
                status: r.status,
                expiresAt: r.expiresAt,
                approved: r.approved,
                documentCount: r.documents.length,
                now,
              });
              const isExpired = r.expiresAt <= now;
              return (
                <tr key={r.id} className="border-b border-line last:border-0 hover:bg-black/[0.015]">
                  <td className="px-4 py-3">
                    <Link
                      href={`/assignments/${r.clientId}/${r.projectId}`}
                      className="font-medium text-ink hover:text-accent"
                    >
                      {r.client.companyName}
                    </Link>
                    <p className="text-[11px] text-ink-muted">
                      {r.project.name}
                      {r.periodName && ` · ${r.periodName}`}
                    </p>
                  </td>
                  <td className="px-4 py-3 text-ink">
                    {r.title}
                    <p className="text-[11px] text-ink-muted">
                      {r.kind === "UPLOAD" ? "Document upload" : "Approval"} · asked by{" "}
                      {r.createdByLabel}
                    </p>
                  </td>
                  <td className="px-4 py-3 text-ink-muted">{r.activity?.subTask.name ?? "—"}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                        state.tone === "good"
                          ? "bg-[var(--status-done-soft)] text-[var(--status-done)]"
                          : state.tone === "bad"
                            ? "bg-overdue-soft text-overdue"
                            : "bg-[var(--status-review-soft)] text-[var(--status-review)]"
                      }`}
                    >
                      {state.label}
                    </span>
                    <p className="mt-0.5 text-[11px] text-ink-muted">
                      {r.viewCount === 0
                        ? "not opened"
                        : `opened ${r.viewCount}×${r.lastViewedAt ? ` · ${formatDate(r.lastViewedAt)}` : ""}`}
                    </p>
                  </td>
                  <td className="tabular px-4 py-3 whitespace-nowrap text-ink-muted">
                    {formatDate(r.createdAt)}
                  </td>
                  <td
                    className={`tabular px-4 py-3 whitespace-nowrap ${
                      isExpired ? "font-medium text-overdue" : "text-ink-muted"
                    }`}
                  >
                    {formatDate(r.expiresAt)}
                  </td>
                </tr>
              );
            })}
            {sorted.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-ink-muted">
                  Nothing is waiting on a client. Raise a request from an engagement&apos;s
                  Client requests panel.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Lower sorts first. Expired links need a new one; never-opened may mean the
// mail never arrived; opened-but-silent is a nudge.
function urgency(
  r: { expiresAt: Date; viewCount: number; documents: { id: string }[] },
  now: Date
): number {
  if (r.expiresAt <= now) return 0;
  if (r.viewCount === 0) return 1;
  if (r.documents.length === 0) return 2;
  return 3;
}
