import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

// Encryption at rest for small secrets the app has to be able to read back —
// today, each person's TOTP secret. (Passwords, tokens and recovery codes are
// hashed instead; those never need reading back.)
//
// AES-256-GCM with a key derived from the AUTH_SECRET environment variable.
// A database copy on its own is then not enough to generate somebody's 2FA
// codes — you'd need the server's environment too.
//
// AUTH_SECRET is optional so the app still runs with zero setup. Without it,
// values are stored with a "plain:" prefix and the Account page says 2FA
// secrets are not encrypted. Setting AUTH_SECRET later is safe: old plain
// values still read, and each is re-encrypted the next time it is written.
// CHANGING AUTH_SECRET makes existing encrypted values unreadable (everyone
// would need to set 2FA up again), so treat it like a database password.
//
// Pure apart from reading the environment — see scripts/test-security.ts.

const VERSION = "v1";

function keyFrom(secret: string): Buffer {
  return createHash("sha256").update(`workflow:secret-box:${secret}`).digest();
}

export function sealingKey(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const secret = env.AUTH_SECRET?.trim();
  return secret ? keyFrom(secret) : null;
}

export function seal(plaintext: string, key: Buffer | null = sealingKey()): string {
  if (!key) return `plain:${plaintext}`;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), tag.toString("base64url"), ct.toString("base64url")].join(":");
}

export function unseal(sealed: string, key: Buffer | null = sealingKey()): string {
  if (sealed.startsWith("plain:")) return sealed.slice("plain:".length);
  const [version, iv, tag, ct] = sealed.split(":");
  if (version !== VERSION || !iv || !tag || !ct) throw new Error("Unrecognised sealed value.");
  if (!key) {
    throw new Error("This value is encrypted, but AUTH_SECRET isn't set on the server.");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("Couldn't decrypt a stored secret — has AUTH_SECRET changed?");
  }
}

export function isEncryptionConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.AUTH_SECRET?.trim());
}
