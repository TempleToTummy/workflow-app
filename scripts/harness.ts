// The three lines of test harness this app needs.
//
// There is no test framework here on purpose: every rule worth testing lives
// in a pure module with no next/* and no Prisma import (src/lib/time.ts,
// workload.ts, mentions.ts, client-requests.ts, csv.ts, due-dates.ts,
// default-assignees.ts, email.ts), so `tsx script.ts` is a complete test
// runner and adds nothing to install, configure or keep up to date.
//
// Each script calls check(), then finish() to print the tally and set the exit
// code. The counters are module-level so a script split across several
// sections still reports one total.

let pass = 0;
let fail = 0;
const failures: string[] = [];

export function check(label: string, actual: unknown, expected: unknown): void {
  // JSON comparison rather than deep-equal: it handles the arrays, objects and
  // primitives these tests produce, and it prints a readable diff for free.
  // Dates serialize to ISO strings, which compare correctly.
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(
    `${ok ? "  ok  " : "  FAIL"} ${label}${
      ok ? "" : ` → got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`
    }`
  );
  if (ok) {
    pass += 1;
  } else {
    fail += 1;
    failures.push(label);
  }
}

// For the cases where the assertion is "this throws, with this message".
export function checkThrows(label: string, fn: () => unknown, expectedMessage?: string): void {
  try {
    fn();
    check(label, "did not throw", `threw${expectedMessage ? `: ${expectedMessage}` : ""}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (expectedMessage) check(label, message, expectedMessage);
    else check(label, "threw", "threw");
  }
}

export function section(name: string): void {
  console.log(`\n${name}`);
}

export function finish(): void {
  if (failures.length > 0) {
    console.log(`\nfailed: ${failures.join(", ")}`);
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
