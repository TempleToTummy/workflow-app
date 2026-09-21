import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

// Pure crypto helpers, deliberately free of any `next/*` import so prisma/seed.ts
// (run through tsx, outside Next) can use hashPassword. Auth session/cookie
// plumbing lives in src/lib/auth.ts.

const scryptAsync = promisify(scrypt);
const KEY_LEN = 64;

// Stored form: "<saltHex>:<derivedKeyHex>". scrypt is in Node's stdlib, so this
// adds no dependency; it's a sound password KDF for an app this size.
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const derived = (await scryptAsync(password, salt, KEY_LEN)) as Buffer;
  return `${salt}:${derived.toString("hex")}`;
}

export async function verifyPassword(
  password: string,
  stored: string
): Promise<boolean> {
  const [salt, keyHex] = stored.split(":");
  if (!salt || !keyHex) return false;
  const derived = (await scryptAsync(password, salt, KEY_LEN)) as Buffer;
  const key = Buffer.from(keyHex, "hex");
  return key.length === derived.length && timingSafeEqual(key, derived);
}

// 256 bits of randomness — used for session ids, invite tokens and reset
// tokens.
export function newToken(): string {
  return randomBytes(32).toString("hex");
}

// Reset tokens are stored as a hash, never in the clear. The raw token exists
// only in the email (and once in the admin's clipboard), so a database read
// isn't enough to take over an account. Plain SHA-256 is the right tool here
// and scrypt would be the wrong one: the input is already 256 bits of
// randomness, so there is nothing to brute force and no reason to pay a KDF's
// cost on every lookup.
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export const INVITE_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days
export const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
// Short on purpose. An invite is expected to sit in an inbox for days; a reset
// link is acted on immediately, so a long window is pure extra exposure.
export const RESET_TTL_MS = 1000 * 60 * 60; // 1 hour

export function inviteExpiry(from: Date = new Date()): Date {
  return new Date(from.getTime() + INVITE_TTL_MS);
}

export function resetExpiry(from: Date = new Date()): Date {
  return new Date(from.getTime() + RESET_TTL_MS);
}

export const RESET_TTL_LABEL = "1 hour";

export const MIN_PASSWORD_LENGTH = 8;
