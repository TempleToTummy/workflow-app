import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// Time-based one-time passwords (RFC 6238 / RFC 4226), with nothing but
// node:crypto. Pure — no next/*, no Prisma — and checked against the RFC's
// own test vectors in scripts/test-security.ts.
//
// Parameters are the ones every authenticator app assumes when a QR code
// doesn't say otherwise: HMAC-SHA1, 6 digits, 30-second steps.

export const TOTP_DIGITS = 6;
export const TOTP_PERIOD_SECONDS = 30;
// Accept the previous and next step as well as the current one, so a phone
// clock a few seconds off (or a code typed as it rolls over) still works.
export const TOTP_WINDOW = 1;

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32.indexOf(ch);
    if (idx < 0) throw new Error("That secret contains characters that aren't base32.");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// 160 bits, the size RFC 4226 recommends for HMAC-SHA1.
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function timeStep(now: Date | number = Date.now()): number {
  const ms = typeof now === "number" ? now : now.getTime();
  return Math.floor(ms / 1000 / TOTP_PERIOD_SECONDS);
}

// HOTP (RFC 4226 §5.3) for one counter value.
export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", secret).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(binary % 10 ** digits).padStart(digits, "0");
}

export function totpCode(secretBase32: string, now: Date | number = Date.now()): string {
  return hotp(base32Decode(secretBase32), timeStep(now));
}

// What people type: "123 456", "123-456". Anything else isn't a code.
export function normalizeTotpInput(input: string): string | null {
  const digits = input.replace(/[\s-]/g, "");
  return /^\d{6}$/.test(digits) ? digits : null;
}

export type TotpCheck = { ok: true; step: number } | { ok: false };

// Checks a code, refusing any step at or before `lastUsedStep` — a code that
// has already signed somebody in can't be used again inside its 30-90
// seconds of validity (someone reading it over a shoulder, a phished code
// replayed a moment later).
export function verifyTotp(
  secretBase32: string,
  input: string,
  options: { now?: Date | number; lastUsedStep?: number | null } = {}
): TotpCheck {
  const code = normalizeTotpInput(input);
  if (!code) return { ok: false };
  const secret = base32Decode(secretBase32);
  const current = timeStep(options.now ?? Date.now());
  for (let delta = -TOTP_WINDOW; delta <= TOTP_WINDOW; delta += 1) {
    const step = current + delta;
    if (options.lastUsedStep != null && step <= options.lastUsedStep) continue;
    const expected = Buffer.from(hotp(secret, step));
    if (timingSafeEqual(expected, Buffer.from(code))) return { ok: true, step };
  }
  return { ok: false };
}

// The otpauth:// URI an authenticator app reads from the QR code.
export function otpauthUri(input: { secret: string; account: string; issuer: string }): string {
  const label = encodeURIComponent(`${input.issuer}:${input.account}`);
  const params = new URLSearchParams({
    secret: input.secret,
    issuer: input.issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// The secret grouped in fours for typing into an app by hand.
export function formatSecretForDisplay(secret: string): string {
  return secret.replace(/(.{4})/g, "$1 ").trim();
}

// --- Recovery codes -------------------------------------------------------------
//
// Ten single-use codes for when the phone is lost. Shown once, stored only as
// SHA-256 hashes. They're 10 characters from a 31-symbol alphabet (~50 bits):
// far too many to guess through a rate-limited form, which is why a plain
// hash (not a slow KDF) is enough — the same reasoning as reset tokens.

// No 0/O/1/I/L, so a code read off paper can't be mistyped into another one.
const RECOVERY_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const RECOVERY_CODE_COUNT = 10;

export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  const codes = new Set<string>();
  while (codes.size < count) {
    const bytes = randomBytes(10);
    let raw = "";
    for (const b of bytes) raw += RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length];
    codes.add(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }
  return [...codes];
}

// Case, spaces and the dash don't matter when typing one back in.
export function normalizeRecoveryCode(input: string): string | null {
  const clean = input.toUpperCase().replace(/[\s-]/g, "");
  if (clean.length !== 10) return null;
  for (const ch of clean) if (!RECOVERY_ALPHABET.includes(ch)) return null;
  return clean;
}

export function hashRecoveryCode(code: string): string {
  const normalized = normalizeRecoveryCode(code) ?? code;
  return createHash("sha256").update(`recovery:${normalized}`).digest("hex");
}

// Returns the remaining hashes if the code matched one (it's spent), or null.
export function consumeRecoveryCode(storedJson: string | null, input: string): string[] | null {
  if (!storedJson || !normalizeRecoveryCode(input)) return null;
  let hashes: unknown;
  try {
    hashes = JSON.parse(storedJson);
  } catch {
    return null;
  }
  if (!Array.isArray(hashes)) return null;
  const target = hashRecoveryCode(input);
  const idx = hashes.indexOf(target);
  if (idx < 0) return null;
  return hashes.filter((_, i) => i !== idx) as string[];
}

export function recoveryCodesRemaining(storedJson: string | null): number {
  try {
    const parsed = JSON.parse(storedJson ?? "[]");
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}
