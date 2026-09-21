// Covers the pure logic behind default assignees, password-reset tokens and
// rate limiting. No framework, no database — run it with:
//
//   ./node_modules/.bin/tsx scripts/test-workflow-rules.ts
import { resolveDefaultAssignees, describeDefaultSource } from "../src/lib/default-assignees";
import { hashToken, newToken, resetExpiry, RESET_TTL_MS } from "../src/lib/password";
import { rateLimit, clearRateLimit } from "../src/lib/rate-limit";

let pass = 0;
let fail = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(
    `${ok ? "  ok  " : "  FAIL"} ${label}${
      ok ? "" : ` → got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`
    }`
  );
  if (ok) pass += 1;
  else fail += 1;
}

console.log("default assignees — precedence");
const steps = [
  { subTaskId: "doc", defaultAssigneeId: null },
  { subTaskId: "entry", defaultAssigneeId: null },
  { subTaskId: "review2", defaultAssigneeId: "marcus" },
];

// The core rule: a step that names a specialist keeps them, even when the
// client has an owner. Getting this backwards would let a client owner
// silently take over a reviewer sign-off.
const both = resolveDefaultAssignees({ steps, engagementDefaultId: "dana" });
check("engagement owner fills unnamed steps", both.get("doc"), "dana");
check("step specialist beats engagement owner", both.get("review2"), "marcus");
check("every step resolved", both.size, 3);

const stepsOnly = resolveDefaultAssignees({ steps, engagementDefaultId: null });
check("no engagement owner → only the specialist step", [...stepsOnly.entries()], [["review2", "marcus"]]);

const noneAtAll = resolveDefaultAssignees({
  steps: [{ subTaskId: "doc", defaultAssigneeId: null }],
  engagementDefaultId: null,
});
check("no defaults → nothing assigned, not a guess", noneAtAll.size, 0);

const undefinedOwner = resolveDefaultAssignees({ steps, engagementDefaultId: undefined });
check("undefined owner behaves like null", undefinedOwner.size, 1);

const names: Record<string, string> = { marcus: "Marcus Webb", dana: "Dana Ruiz" };
const nameOf = (id: string) => names[id];
check("describes a step specialist", describeDefaultSource("marcus", "dana", nameOf), "Always Marcus Webb");
check("describes an engagement owner", describeDefaultSource(null, "dana", nameOf), "Dana Ruiz (engagement)");
check("describes nothing set", describeDefaultSource(null, null, nameOf), "Unassigned");

console.log("\nreset tokens");
const raw = newToken();
check("token is 256 bits of hex", raw.length, 64);
check("hash is stable", hashToken(raw), hashToken(raw));
check("hash differs from the raw token", hashToken(raw) === raw, false);
check("different tokens hash differently", hashToken(raw) === hashToken(newToken()), false);
const ttl = resetExpiry(new Date(0)).getTime();
check("reset expiry is one hour", ttl, RESET_TTL_MS);
check("reset window is much shorter than an invite", RESET_TTL_MS < 1000 * 60 * 60 * 24, true);

console.log("\nrate limiting");
const key = `test:${Math.random()}`;
const opts = { limit: 3, windowMs: 60_000 };
check("1st attempt allowed", rateLimit(key, opts).ok, true);
check("2nd attempt allowed", rateLimit(key, opts).ok, true);
check("3rd attempt allowed", rateLimit(key, opts).ok, true);
const blocked = rateLimit(key, opts);
check("4th attempt blocked", blocked.ok, false);
check("blocked response says when to retry", blocked.retryAfterSeconds > 0, true);
clearRateLimit(key);
check("clearing lets a successful sign-in through again", rateLimit(key, opts).ok, true);

const other = `test:${Math.random()}`;
check("limits are per key, not global", rateLimit(other, opts).ok, true);

// Wrapped rather than using top-level await: tsx transpiles this file to CJS,
// which has no top-level await.
async function windowExpiry() {
  const expiring = `test:${Math.random()}`;
  rateLimit(expiring, { limit: 1, windowMs: 1 });
  await new Promise((r) => setTimeout(r, 5));
  check("window resets after it elapses", rateLimit(expiring, { limit: 1, windowMs: 1 }).ok, true);
}

windowExpiry().then(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
});
