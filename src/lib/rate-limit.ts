// A small fixed-window rate limiter.
//
// The login form had no throttling at all, which made it a free brute-force
// target; adding password reset would have added a second one, plus a way to
// spam somebody's inbox. Both go through this.
//
// Deliberately in-memory: this app runs as a single Node process against local
// SQLite, so a Map is the honest fit and adds no dependency or table. It has
// the limits that implies — counters reset when the server restarts, and it
// does not coordinate across instances. If the app is ever deployed to more
// than one instance, this needs to move to the database or a shared cache, or
// it silently multiplies every limit by the instance count.

type Window = { count: number; resetAt: number };

const buckets = new Map<string, Window>();

// Keeps the Map from growing without bound on a long-running process: every
// so often, drop windows that have already expired.
let lastSweep = Date.now();
const SWEEP_INTERVAL_MS = 60_000;

function sweep(now: number) {
  if (now - lastSweep < SWEEP_INTERVAL_MS) return;
  lastSweep = now;
  for (const [key, window] of buckets) {
    if (window.resetAt <= now) buckets.delete(key);
  }
}

export type RateLimitResult = {
  ok: boolean;
  remaining: number;
  retryAfterSeconds: number;
};

// Counts one attempt against `key`. Returns ok:false once the window is full.
export function rateLimit(
  key: string,
  options: { limit: number; windowMs: number }
): RateLimitResult {
  const now = Date.now();
  sweep(now);

  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + options.windowMs });
    return { ok: true, remaining: options.limit - 1, retryAfterSeconds: 0 };
  }

  existing.count += 1;
  const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
  if (existing.count > options.limit) {
    return { ok: false, remaining: 0, retryAfterSeconds };
  }
  return {
    ok: true,
    remaining: Math.max(0, options.limit - existing.count),
    retryAfterSeconds,
  };
}

// Clears a key's window — called after a successful sign-in so a user who
// mistyped a few times isn't still penalised once they get it right.
export function clearRateLimit(key: string): void {
  buckets.delete(key);
}

export const LIMITS = {
  // Per email address. Generous enough for a forgetful human, tight enough
  // that guessing a password is hopeless.
  LOGIN: { limit: 10, windowMs: 15 * 60_000 },
  // Per email address. Reset mails are sent to a real inbox, so this is as
  // much an anti-spam measure as an anti-enumeration one.
  PASSWORD_RESET: { limit: 5, windowMs: 60 * 60_000 },
  // Per token. Reset tokens are 256-bit, so this is belt and braces.
  RESET_REDEEM: { limit: 10, windowMs: 15 * 60_000 },
} as const;
