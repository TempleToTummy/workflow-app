// Covers @mention parsing and the threading rule for task comments:
//
//   ./node_modules/.bin/tsx scripts/test-discussion.ts
import { check, section, finish } from "./harness";
import {
  findMentions,
  resolveMentionedIds,
  segmentBody,
  resolveParentId,
} from "../src/lib/mentions";

const staff = [
  { id: "dana", firstName: "Dana", lastName: "Ruiz", email: "dana.ruiz@firm.test" },
  { id: "marcus", firstName: "Marcus", lastName: "Webb", email: "marcus@firm.test" },
  { id: "priya", firstName: "Priya", lastName: "Shah", email: "priya.shah@firm.test" },
];

const ids = (body: string, authorId: string | null = null) =>
  resolveMentionedIds(body, staff, authorId);

// Two people called Dana, used by the ambiguity checks below.
const twoDanasEarly = [
  ...staff,
  { id: "dana2", firstName: "Dana", lastName: "Okafor", email: "dana.okafor@firm.test" },
];

section("resolving a mention");
check("a first name", ids("@Marcus can you take second review?"), ["marcus"]);
check("a full name", ids("Handing to @Dana Ruiz for signoff"), ["dana"]);
check("case is ignored", ids("@marcus please look"), ["marcus"]);
check("a dotted form", ids("@dana.ruiz has the file"), ["dana"]);
check("a hyphenated form", ids("@priya-shah is out today"), ["priya"]);
check("an email local part", ids("@marcus@firm.test"), ["marcus"]);
check("two people in one comment", ids("@Marcus and @Priya both signed"), ["marcus", "priya"]);
check("the same person twice is one mention", ids("@Dana — @Dana, urgent"), ["dana"]);
check("a mention in parentheses", ids("(@Priya) see note"), ["priya"]);
check("a mention at the very start", ids("@Priya"), ["priya"]);
check("a mention at the very end", ids("over to @Priya"), ["priya"]);
check("a mention before punctuation", ids("thanks @Marcus!"), ["marcus"]);
check("a mention on its own line", ids("done\n@Marcus review please"), ["marcus"]);

section("what must NOT resolve");
check("nobody mentioned", ids("Bank rec done, moving on."), []);
check("an unknown name", ids("@Jordan take a look"), []);
// The one that would otherwise fire on every comment containing an address.
check("an email address is not a mention", ids("write to client@example.com about it"), []);
check("a longer name is not a prefix match", ids("@Marcuson filed it"), []);
check("a bare @ is not a mention", ids("cost @ 150/hr"), []);
// Mentioning yourself is a figure of speech, not a notification.
check("the author is not notified about themselves", ids("@Marcus here, picking this up", "marcus"), []);
check("but the author's mention of someone else still lands", ids("@Marcus here — @Dana FYI", "marcus"), ["dana"]);

section("an @name that matched nobody is reported, not swallowed");
// This is the failure that matters: the author believes they handed the task
// over. Nothing is notified and nothing is highlighted — but the composer has
// to be able to say so.
const unresolved = (body: string) =>
  findMentions(body, staff).filter((m) => !m.employeeId).map((m) => m.text);
check("an unknown first name is flagged", unresolved("@Jordan take a look"), ["@Jordan"]);
check("an unknown full name is flagged once, not twice", unresolved("@Jordan Blake please review"), ["@Jordan Blake"]);
check("a known name is not flagged", unresolved("@Marcus take a look"), []);
check("an ambiguous name is flagged too", findMentions("@Dana review", twoDanasEarly).filter((m) => !m.employeeId).map((m) => m.text), ["@Dana"]);
// The guards still hold: neither of these is a name somebody typed.
check("an email address is still not flagged", unresolved("write to client@example.com"), []);
check("a bare @ is still not flagged", unresolved("cost @ 150/hr"), []);
check("@ before punctuation is not flagged", unresolved("ping @ !"), []);
// And an unmatched name still notifies nobody.
check("an unknown name notifies nobody", ids("@Jordan take a look"), []);

section("ambiguity refuses to guess");
// Two people called Dana: "@Dana" matches the text but must resolve to
// nobody. Notifying the wrong Dana about a reviewer handoff is worse than
// notifying neither, and the full name still works.
const twoDanas = twoDanasEarly;
check("an ambiguous first name resolves to nobody", resolveMentionedIds("@Dana please review", twoDanas, null), []);
check("but it is still matched as text", findMentions("@Dana please review", twoDanas)[0].text, "@Dana");
check("the full name disambiguates", resolveMentionedIds("@Dana Okafor please review", twoDanas, null), ["dana2"]);
check("the other full name too", resolveMentionedIds("@Dana Ruiz please review", twoDanas, null), ["dana"]);

section("longest match wins");
// "@Dana Ruiz" must not be read as "@Dana" followed by stray text.
const full = findMentions("@Dana Ruiz signed off", staff);
check("one match, not two", full.length, 1);
check("the full name is consumed", full[0].text, "@Dana Ruiz");
check("and the range covers it", [full[0].start, full[0].end], [0, 10]);

section("rendering segments");
check("a body with no mentions is one plain segment", segmentBody("Bank rec done.", staff), [
  { text: "Bank rec done.", mention: false },
]);
check("a mention is split out for highlighting", segmentBody("over to @Priya now", staff), [
  { text: "over to ", mention: false },
  { text: "@Priya", mention: true },
  { text: " now", mention: false },
]);
check("a mention at the start has no leading segment", segmentBody("@Priya now", staff), [
  { text: "@Priya", mention: true },
  { text: " now", mention: false },
]);
check("two mentions", segmentBody("@Dana and @Marcus", staff), [
  { text: "@Dana", mention: true },
  { text: " and ", mention: false },
  { text: "@Marcus", mention: true },
]);
// An unresolved name renders as ordinary text: highlighting it would promise
// a notification that was never sent.
check("an unresolved mention is not highlighted", segmentBody("@Jordan take a look", staff), [
  { text: "@Jordan take a look", mention: false },
]);
check("segments reassemble to the original body", segmentBody("hi @Dana and @Marcus, thanks", staff).map((s) => s.text).join(""), "hi @Dana and @Marcus, thanks");

section("threading stays one level deep");
check("a root comment has no parent", resolveParentId(null, null), null);
check("a reply to a root keeps that root", resolveParentId("root-1", null), "root-1");
// A reply to a reply is re-parented onto the root, so the database can never
// hold a chain deeper than the UI renders.
check("a reply to a reply is re-parented to the root", resolveParentId("reply-1", "root-1"), "root-1");
check("a third-level reply also lands on the root", resolveParentId("reply-2", "root-1"), "root-1");

finish();
