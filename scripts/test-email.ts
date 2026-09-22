// Exercises the email library directly: transport selection, reply-token
// round trip, template rendering, quoted-reply stripping, and the tolerant
// inbound payload parser.
import {
  emailTransport,
  transportIsLive,
  senderAddress,
  newReplyToken,
  replyToAddress,
  extractReplyToken,
  threadKeyFor,
  renderTemplate,
  templateVariables,
  parseAddressList,
  displayName,
  isValidAddress,
  stripQuotedReply,
  parseInboundPayload,
  textToHtml,
} from "../src/lib/email";

// The library reads its addresses from the environment, and every reader but
// the transport picker is lazy, so setting them here (rather than relying on a
// .env that a fresh clone won't have) makes this script self-contained: `npm
// test` passes from a clean checkout instead of only on a machine where these
// happen to be exported.
process.env.EMAIL_FROM = "workflow@example.com";
process.env.EMAIL_FROM_NAME = "Workflow";
process.env.EMAIL_INBOUND_DOMAIN = "reply.example.com";
process.env.EMAIL_INBOUND_PREFIX = "reply";

let pass = 0;
let fail = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${ok ? "" : ` → got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`);
  if (ok) pass += 1;
  else fail += 1;
}

console.log("transport");
check("name is log with no RESEND_API_KEY", emailTransport.name, "log");
check("transportIsLive false", transportIsLive(), false);
check("sender includes display name", senderAddress(), "Workflow <workflow@example.com>");

console.log("\nreply-token round trip");
const token = newReplyToken();
const addr = replyToAddress(token)!;
check("address shape", addr, `reply+${token}@reply.example.com`);
check("token recovered from bare address", extractReplyToken(addr), token);
check("token recovered from display form", extractReplyToken(`Workflow <${addr}>`), token);
check("token recovered from a list", extractReplyToken(["someone@else.com", addr]), token);
check("foreign address yields null", extractReplyToken("nobody@elsewhere.com"), null);
check("wrong prefix yields null", extractReplyToken(`other+${token}@reply.example.com`), null);

console.log("\naddress parsing");
check("list splits and lowercases", parseAddressList("Alice <A@X.com>, b@y.com"), ["a@x.com", "b@y.com"]);
check("display name extracted", displayName('"Jane Doe" <j@x.com>'), "Jane Doe");
check("valid address", isValidAddress("a@b.co"), true);
check("invalid address", isValidAddress("not-an-address"), false);

console.log("\nthreading");
check(
  "engagement thread key",
  threadKeyFor({ clientId: "c1", projectId: "p1", periodName: "2026-09" }),
  "eng:c1:p1:2026-09"
);
check("client-only thread key", threadKeyFor({ clientId: "c1" }), "client:c1");

console.log("\ntemplates");
check(
  "placeholders interpolate",
  renderTemplate("Hi {{contact_first_name}}, {{project_name}} for {{period}}", {
    contact_first_name: "Sam",
    project_name: "Bookkeeping",
    period: "2026-09",
  }),
  "Hi Sam, Bookkeeping for 2026-09"
);
check("unknown placeholder collapses to empty", renderTemplate("a{{nope}}b", {}), "ab");
check("variables discovered", templateVariables("{{a}} {{ b }} {{a}}").sort(), ["a", "b"]);

console.log("\ninbound parsing");
check(
  "quoted reply stripped",
  stripQuotedReply("Sounds good, thanks.\n\nOn Tue, Sep 1 someone wrote:\n> original"),
  "Sounds good, thanks."
);
const resendShape = parseInboundPayload({
  type: "inbound.email.received",
  data: {
    from: "Owner <owner@bakery.com>",
    to: [addr],
    subject: "Re: documents",
    text: "Sending them over now.",
    message_id: "prov_123",
  },
});
check("resend-style envelope", resendShape?.from, "owner@bakery.com");
check("recipient carries our token", extractReplyToken(resendShape!.to), token);
const flatShape = parseInboundPayload({
  From: "a@b.com",
  To: "reply@reply.example.com",
  Subject: "Hello",
  TextBody: "hi",
});
check("postmark-style envelope", flatShape?.subject, "Hello");
check("payload with no sender rejected", parseInboundPayload({ subject: "x" }), null);

// Resend's real email.received webhook is metadata ONLY — no body. The route
// has to notice that and fetch the body separately with data.email_id, so the
// parser must surface that id and leave text empty rather than inventing one.
const metadataOnly = parseInboundPayload({
  type: "email.received",
  created_at: "2026-09-20T18:00:00Z",
  data: {
    email_id: "4ef9a417-02e9-4d39-ad75-9611e0fcc33c",
    from: "owner@bakery.test",
    to: [addr],
    subject: "Re: documents",
  },
});
check("metadata-only body is empty", metadataOnly?.text, "");
check("metadata-only exposes email_id", metadataOnly?.emailId, "4ef9a417-02e9-4d39-ad75-9611e0fcc33c");
check("metadata-only still yields the token", extractReplyToken(metadataOnly!.to), token);
check("inline-body payload needs no fetch", resendShape?.emailId, null);

console.log("\nhtml");
check("escapes and paragraphs", textToHtml("a<b\n\nc").includes("a&lt;b"), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
