// Covers the client-facing request rules — the access decision, the upload
// allow-list, and the step suggestions:
//
//   ./node_modules/.bin/tsx scripts/test-client-requests.ts
//
// This is the only part of the app that grants access to somebody outside the
// firm, so the decision to let a link through is tested in isolation rather
// than only through the page that calls it.
import { check, section, finish } from "./harness";
import {
  blockReason,
  isActionable,
  statusAfterResponse,
  describeRequest,
  checkUpload,
  fileExtension,
  suggestedKindForStep,
  defaultTitle,
  requestUrl,
  requestExpiry,
  REQUEST_TTL_MS,
  MAX_UPLOAD_BYTES,
} from "../src/lib/client-requests";
import { newToken, hashToken } from "../src/lib/password";

const now = new Date("2026-09-22T12:00:00");
const future = new Date("2026-10-01T12:00:00");
const past = new Date("2026-09-01T12:00:00");

section("the access decision");
check("an open, unexpired link works", blockReason({ status: "OPEN", expiresAt: future }, now), null);
check("and isActionable agrees", isActionable({ status: "OPEN", expiresAt: future }, now), true);
check("an expired link is refused", blockReason({ status: "OPEN", expiresAt: past }, now), "expired");
check("a revoked link is refused", blockReason({ status: "CANCELLED", expiresAt: future }, now), "cancelled");
check("a completed link is closed", blockReason({ status: "COMPLETED", expiresAt: future }, now), "completed");
// Revocation has to beat everything: staff pressing "revoke" must stop the
// link even if it would otherwise still be open.
check("revoking beats an otherwise-valid link", blockReason({ status: "CANCELLED", expiresAt: future }, now), "cancelled");
check("revoking beats expiry too", blockReason({ status: "CANCELLED", expiresAt: past }, now), "cancelled");
// The boundary: expiry is a hard cutoff, not a rounded day.
check("expiring exactly now is expired", blockReason({ status: "OPEN", expiresAt: now }, now), "expired");
check("expiring one millisecond from now still works", blockReason({ status: "OPEN", expiresAt: new Date(now.getTime() + 1) }, now), null);
check("nothing is actionable once blocked", isActionable({ status: "OPEN", expiresAt: past }, now), false);

section("expiry window");
check("the window is fourteen days", REQUEST_TTL_MS, 1000 * 60 * 60 * 24 * 14);
check("expiry is computed from the given moment", requestExpiry(now).getTime() - now.getTime(), REQUEST_TTL_MS);

section("tokens are stored hashed, never raw");
const token = newToken();
check("a token is 256 bits of hex", token.length, 64);
check("the stored hash is not the token", hashToken(token) === token, false);
check("hashing is stable, so lookup works", hashToken(token), hashToken(token));
check("two tokens don't collide", hashToken(token) === hashToken(newToken()), false);

section("what stays open after a response");
// Clients send bank statements in three separate messages. Closing on the
// first would make them ask for a new link twice.
check("an upload request stays open for more files", statusAfterResponse("UPLOAD"), "OPEN");
// An approval is a decision; there is nothing further to say once it's made.
check("an approval closes on the decision", statusAfterResponse("APPROVAL"), "COMPLETED");

section("how a request reads to staff");
const base = { expiresAt: future, now, documentCount: 0, approved: null as boolean | null };
check("nothing yet", describeRequest({ ...base, kind: "UPLOAD", status: "OPEN" }), { label: "Waiting on client", tone: "waiting" });
check("one file in", describeRequest({ ...base, kind: "UPLOAD", status: "OPEN", documentCount: 1 }), { label: "1 file received", tone: "good" });
check("several files in", describeRequest({ ...base, kind: "UPLOAD", status: "OPEN", documentCount: 3 }), { label: "3 files received", tone: "good" });
check("approved", describeRequest({ ...base, kind: "APPROVAL", status: "COMPLETED", approved: true }), { label: "Approved by client", tone: "good" });
check("changes requested is not a failure, but is not approval either", describeRequest({ ...base, kind: "APPROVAL", status: "COMPLETED", approved: false }), { label: "Changes requested", tone: "warn" });
check("an expired link that got nothing", describeRequest({ ...base, kind: "UPLOAD", status: "OPEN", expiresAt: past }), { label: "Link expired", tone: "warn" });
// A link that expired AFTER the client delivered is not a problem to chase.
check("an expired link that did get files reports the files", describeRequest({ ...base, kind: "UPLOAD", status: "OPEN", expiresAt: past, documentCount: 2 }), { label: "2 files received", tone: "good" });
check("revoked", describeRequest({ ...base, kind: "UPLOAD", status: "CANCELLED" }), { label: "Revoked", tone: "bad" });

section("upload allow-list");
check("a pdf is fine", checkUpload({ name: "statement.pdf", size: 1000 }), { ok: true });
check("a spreadsheet is fine", checkUpload({ name: "ledger.xlsx", size: 1000 }), { ok: true });
check("a phone photo is fine", checkUpload({ name: "receipt.HEIC", size: 1000 }), { ok: true });
check("case in the extension doesn't matter", checkUpload({ name: "SCAN.PDF", size: 1000 }), { ok: true });
check("a dotted filename uses the last extension", fileExtension("bank.statement.2026.pdf"), "pdf");
// The point of the allow-list: nothing that executes.
check("an executable is refused", checkUpload({ name: "invoice.exe", size: 1000 }).ok, false);
check("a script is refused", checkUpload({ name: "run.sh", size: 1000 }).ok, false);
check("an html file is refused", checkUpload({ name: "page.html", size: 1000 }).ok, false);
// A double extension must be judged on the LAST one, which is what actually
// runs — "invoice.pdf.exe" is an executable.
check("a double extension is judged on the real one", checkUpload({ name: "invoice.pdf.exe", size: 1000 }).ok, false);
check("no extension at all is refused", checkUpload({ name: "document", size: 1000 }).ok, false);
check("a trailing dot is not an extension", fileExtension("document."), "");
check("a dotfile has no extension", fileExtension(".gitignore"), "");
check("an empty file is refused", checkUpload({ name: "empty.pdf", size: 0 }).ok, false);
check("an oversized file is refused", checkUpload({ name: "huge.pdf", size: MAX_UPLOAD_BYTES + 1 }).ok, false);
check("a file exactly at the cap is accepted", checkUpload({ name: "big.pdf", size: MAX_UPLOAD_BYTES }), { ok: true });
// The refusal has to tell a client what to do next, not name an internal.
check("the size refusal says what to do", checkUpload({ name: "huge.pdf", size: MAX_UPLOAD_BYTES + 1 }), {
  ok: false,
  reason: "Files need to be under 15 MB. Please send larger files in separate parts.",
});
check("the type refusal names the extension", checkUpload({ name: "invoice.exe", size: 10 }), {
  ok: false,
  reason: "We can't accept .exe files. Documents, spreadsheets, images and PDFs are fine.",
});

section("suggesting a request from a checklist step");
// Matched on the firm's real, confirmed step names, so the suggestion appears
// on a seeded engagement with no configuration at all.
check("Document Received wants an upload", suggestedKindForStep("Document Received"), "UPLOAD");
check("Review done by Client wants an approval", suggestedKindForStep("Review done by Client"), "APPROVAL");
check("case and padding are ignored", suggestedKindForStep("  review DONE by client "), "APPROVAL");
check("an internal step suggests nothing", suggestedKindForStep("Bank Reconciliation"), null);
check("a reviewer step suggests nothing", suggestedKindForStep("Reviewer Layer 2"), null);
// "Report Sent to Client" is us writing to them, not us waiting on them.
check("sending a report is not a request", suggestedKindForStep("Report Sent to Client"), null);

section("default wording");
check("an upload title", defaultTitle("UPLOAD", "Document Received", "2026-08"), "Documents for Document Received — 2026-08");
check("an approval title", defaultTitle("APPROVAL", "Review done by Client", "2026-08"), "Approval: Review done by Client — 2026-08");
check("no period, no dash", defaultTitle("UPLOAD", "Document Received", null), "Documents for Document Received");

section("the link");
check("a request url", requestUrl("https://firm.test", "abc123"), "https://firm.test/r/abc123");
check("a trailing slash on the base is dropped", requestUrl("https://firm.test/", "abc123"), "https://firm.test/r/abc123");
check("several trailing slashes too", requestUrl("https://firm.test///", "abc123"), "https://firm.test/r/abc123");

finish();
