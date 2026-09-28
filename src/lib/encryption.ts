import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

// Encryption at rest for client data: uploaded files, tax IDs, SSNs, backups.
//
// Pure apart from reading the environment (no next/*, no Prisma), so
// scripts/test-encryption.ts exercises all of it directly.
//
// --- The design -------------------------------------------------------------
//
// Envelope encryption, the pattern AWS KMS, Google Cloud KMS and Supabase Vault
// all use:
//
//   * Every file gets its own random 256-bit data key (DEK). The file is
//     encrypted with AES-256-GCM under that DEK.
//   * The DEK is then "wrapped" (encrypted) with a key-encryption key (KEK)
//     that lives ONLY in the server's environment, never in the database or
//     the storage bucket. The wrapped DEK is stored on the Document row.
//
// So a copy of the storage bucket is ciphertext, a copy of the database is
// wrapped keys and ciphertext, and even both together are useless without the
// server environment. Deleting a Document row destroys the only copy of its
// wrapped DEK ("crypto-shredding"): the bytes become unrecoverable even if the
// object delete fails or a stale replica of the bucket is lying around.
//
// Small fields (tax IDs, SSNs) are encrypted directly with AES-256-GCM under a
// field key derived from the same KEK. Each ciphertext is self-describing
// ("enc:v1:<keyId>:...") so it records which key made it.
//
// Every ciphertext is bound to what it is with GCM's additional authenticated
// data (AAD): a file to its document id, a field to its table and column. An
// attacker who can write to the database can't swap one client's encrypted
// file or SSN into another's slot — decryption fails the integrity check.
//
// --- Keys and rotation ------------------------------------------------------
//
//   DATA_ENCRYPTION_KEYS="2026-09:<base64 32 bytes>,2025-01:<base64 32 bytes>"
//
// A comma-separated key ring. The FIRST key encrypts everything new; the rest
// are kept only so older data still decrypts. Rotating is: generate a key, put
// it first, deploy, run `npm run security:encrypt -- --apply` to re-wrap
// everything onto it, then drop the old key. Re-wrapping a file only re-encrypts
// its 32-byte DEK, not the file, so rotation is cheap at any volume.
//
//   DATA_INDEX_KEY="<base64 32 bytes>"
//
// A separate HMAC key for "blind indexes" — a keyed hash of a tax ID that lets
// the database enforce uniqueness and answer an exact-match search without
// ever holding the value. It is separate so that rotating the encryption key
// doesn't invalidate every index. Unlike an unkeyed hash, a 9-digit number
// hashed under a secret key can't be brute-forced from the database alone.
//
// Generate either with:
//   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
//
// LOSING THESE KEYS MEANS LOSING THE DATA. Keep a copy somewhere that is not
// this server and not the database (the firm's password manager, a KMS).
//
// --- Development -------------------------------------------------------------
//
// Outside production, if no keys are set, a fixed well-known development key
// ("dev") is used so the app still runs with zero setup. It is NOT secret.
// In production (NODE_ENV=production) a missing key is a hard error — the app
// refuses to store a file or a tax ID rather than store it weakly — and
// anything encrypted under the "dev" key refuses to decrypt, so development
// data can never quietly masquerade as protected data.

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // 96-bit nonce, the size GCM is specified for
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export const DEV_KEY_ID = "dev";

// Magic prefix on every encrypted file object: "WFE" + format version 1.
const FILE_MAGIC = Buffer.from("WFE1", "ascii");
const FIELD_PREFIX = "enc:v1:";
const WRAP_VERSION = "w1";

export type KeyRing = {
  // Id of the key that encrypts new data.
  activeId: string;
  keys: Map<string, Buffer>;
  indexKey: Buffer;
  isDevelopmentKey: boolean;
};

export class EncryptionConfigError extends Error {}

function isProduction(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_ENV === "production";
}

function decodeKey(raw: string, label: string): Buffer {
  const trimmed = raw.trim();
  // base64 or base64url; hex is accepted too because that's what the existing
  // AUTH_SECRET / CRON_SECRET instructions generate.
  const buf = /^[0-9a-fA-F]{64}$/.test(trimmed)
    ? Buffer.from(trimmed, "hex")
    : Buffer.from(trimmed.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (buf.length !== KEY_BYTES) {
    throw new EncryptionConfigError(
      `${label} must be 32 random bytes (base64 or hex). Generate one with: ` +
        `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
    );
  }
  return buf;
}

const DEV_MASTER = createHash("sha256").update("workflow-app:development-only-key:not-secret").digest();
const DEV_INDEX = createHash("sha256").update("workflow-app:development-only-index-key:not-secret").digest();

export function parseKeyRing(env: NodeJS.ProcessEnv = process.env): KeyRing {
  const rawKeys = env.DATA_ENCRYPTION_KEYS?.trim();
  const rawIndex = env.DATA_INDEX_KEY?.trim();

  if (!rawKeys || !rawIndex) {
    if (isProduction(env)) {
      throw new EncryptionConfigError(
        `${!rawKeys ? "DATA_ENCRYPTION_KEYS" : "DATA_INDEX_KEY"} is not set. ` +
          "Client files and tax IDs can't be stored without encryption keys — see .env.example."
      );
    }
    if (rawKeys || rawIndex) {
      // Half-configured is always a mistake worth stopping for.
      throw new EncryptionConfigError("Set both DATA_ENCRYPTION_KEYS and DATA_INDEX_KEY, or neither (development only).");
    }
    return {
      activeId: DEV_KEY_ID,
      keys: new Map([[DEV_KEY_ID, DEV_MASTER]]),
      indexKey: DEV_INDEX,
      isDevelopmentKey: true,
    };
  }

  const keys = new Map<string, Buffer>();
  let activeId: string | null = null;
  for (const entry of rawKeys.split(",").map((s) => s.trim()).filter(Boolean)) {
    const sep = entry.indexOf(":");
    if (sep <= 0) {
      throw new EncryptionConfigError('Each DATA_ENCRYPTION_KEYS entry must look like "<keyId>:<base64 key>".');
    }
    const id = entry.slice(0, sep).trim();
    if (!/^[A-Za-z0-9_.-]{1,32}$/.test(id)) {
      throw new EncryptionConfigError(`Key id "${id}" must be 1-32 letters, digits, dots, dashes or underscores.`);
    }
    if (id === DEV_KEY_ID) throw new EncryptionConfigError(`"${DEV_KEY_ID}" is reserved for the development key.`);
    if (keys.has(id)) throw new EncryptionConfigError(`Key id "${id}" appears twice in DATA_ENCRYPTION_KEYS.`);
    keys.set(id, decodeKey(entry.slice(sep + 1), `DATA_ENCRYPTION_KEYS key "${id}"`));
    activeId ??= id;
  }
  if (!activeId) throw new EncryptionConfigError("DATA_ENCRYPTION_KEYS has no keys in it.");

  const indexKey = decodeKey(rawIndex, "DATA_INDEX_KEY");
  for (const [id, k] of keys) {
    if (timingSafeEqual(k, indexKey)) {
      throw new EncryptionConfigError(`DATA_INDEX_KEY must be different from encryption key "${id}".`);
    }
  }
  return { activeId, keys, indexKey, isDevelopmentKey: false };
}

// Parsed once per process; the environment doesn't change under a running
// server. Tests pass their own ring to every function instead.
let cached: KeyRing | null = null;
let warned = false;
export function keyRing(): KeyRing {
  if (!cached) {
    cached = parseKeyRing();
    if (cached.isDevelopmentKey && !warned) {
      warned = true;
      console.warn(
        "[encryption] DATA_ENCRYPTION_KEYS is not set — using the public DEVELOPMENT key. " +
          "Never put real client data in this environment."
      );
    }
  }
  return cached;
}

export function encryptionStatus(env: NodeJS.ProcessEnv = process.env):
  | { ok: true; development: boolean; activeKeyId: string; keyCount: number }
  | { ok: false; error: string } {
  try {
    const ring = parseKeyRing(env);
    return { ok: true, development: ring.isDevelopmentKey, activeKeyId: ring.activeId, keyCount: ring.keys.size };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// Per-purpose subkeys, so the same master key is never used directly for two
// different jobs (wrapping DEKs vs. encrypting fields).
const subkeyCache = new WeakMap<Buffer, Map<string, Buffer>>();
function subkey(master: Buffer, purpose: string): Buffer {
  let byPurpose = subkeyCache.get(master);
  if (!byPurpose) subkeyCache.set(master, (byPurpose = new Map()));
  let k = byPurpose.get(purpose);
  if (!k) {
    k = Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), `workflow:${purpose}:v1`, KEY_BYTES));
    byPurpose.set(purpose, k);
  }
  return k;
}

function masterKey(ring: KeyRing, keyId: string, env: NodeJS.ProcessEnv = process.env): Buffer {
  if (keyId === DEV_KEY_ID && isProduction(env)) {
    throw new Error("This item was encrypted with the public development key and can't be trusted in production.");
  }
  const k = ring.keys.get(keyId);
  if (!k) {
    throw new Error(`Encryption key "${keyId}" isn't in DATA_ENCRYPTION_KEYS — was it removed before re-encrypting?`);
  }
  return k;
}

function gcmEncrypt(key: Buffer, plaintext: Buffer, aad: string): { iv: Buffer; ct: Buffer; tag: Buffer } {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv, ct, tag: cipher.getAuthTag() };
}

function gcmDecrypt(key: Buffer, iv: Buffer, ct: Buffer, tag: Buffer, aad: string): Buffer {
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new IntegrityError();
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw new IntegrityError();
  }
}

// Thrown whenever a ciphertext doesn't authenticate: tampered with, truncated,
// swapped from another record, or encrypted under a different key.
export class IntegrityError extends Error {
  constructor() {
    super("Encrypted data failed its integrity check.");
  }
}

// --- Files ------------------------------------------------------------------

export type EncryptedFile = {
  // What goes to the object store.
  body: Buffer;
  // What goes on the Document row.
  keyId: string;
  wrappedKey: string;
};

function fileAad(documentId: string): string {
  return `workflow:document:${documentId}`;
}

function wrapDek(ring: KeyRing, keyId: string, dek: Buffer, documentId: string): string {
  const kek = subkey(masterKey(ring, keyId), "kek");
  const { iv, ct, tag } = gcmEncrypt(kek, dek, `workflow:dek:${documentId}`);
  return [WRAP_VERSION, iv.toString("base64url"), Buffer.concat([ct, tag]).toString("base64url")].join(":");
}

function unwrapDek(ring: KeyRing, keyId: string, wrapped: string, documentId: string): Buffer {
  const [version, iv, ctTag] = wrapped.split(":");
  if (version !== WRAP_VERSION || !iv || !ctTag) throw new IntegrityError();
  const buf = Buffer.from(ctTag, "base64url");
  const kek = subkey(masterKey(ring, keyId), "kek");
  const dek = gcmDecrypt(
    kek,
    Buffer.from(iv, "base64url"),
    buf.subarray(0, buf.length - TAG_BYTES),
    buf.subarray(buf.length - TAG_BYTES),
    `workflow:dek:${documentId}`
  );
  if (dek.length !== KEY_BYTES) throw new IntegrityError();
  return dek;
}

export function encryptFile(plaintext: Buffer, documentId: string, ring: KeyRing = keyRing()): EncryptedFile {
  const dek = randomBytes(KEY_BYTES);
  try {
    const { iv, ct, tag } = gcmEncrypt(dek, plaintext, fileAad(documentId));
    return {
      // [magic 4][iv 12][ciphertext …][tag 16]
      body: Buffer.concat([FILE_MAGIC, iv, ct, tag]),
      keyId: ring.activeId,
      wrappedKey: wrapDek(ring, ring.activeId, dek, documentId),
    };
  } finally {
    dek.fill(0);
  }
}

export function decryptFile(
  body: Buffer,
  meta: { documentId: string; keyId: string; wrappedKey: string },
  ring: KeyRing = keyRing()
): Buffer {
  const header = FILE_MAGIC.length + IV_BYTES;
  if (body.length < header + TAG_BYTES || !body.subarray(0, FILE_MAGIC.length).equals(FILE_MAGIC)) {
    throw new IntegrityError();
  }
  const dek = unwrapDek(ring, meta.keyId, meta.wrappedKey, meta.documentId);
  try {
    return gcmDecrypt(
      dek,
      body.subarray(FILE_MAGIC.length, header),
      body.subarray(header, body.length - TAG_BYTES),
      body.subarray(body.length - TAG_BYTES),
      fileAad(meta.documentId)
    );
  } finally {
    dek.fill(0);
  }
}

// Moves a file's DEK onto the active key without touching the file itself.
export function rewrapFileKey(
  meta: { documentId: string; keyId: string; wrappedKey: string },
  ring: KeyRing = keyRing()
): { keyId: string; wrappedKey: string } {
  const dek = unwrapDek(ring, meta.keyId, meta.wrappedKey, meta.documentId);
  try {
    return { keyId: ring.activeId, wrappedKey: wrapDek(ring, ring.activeId, dek, meta.documentId) };
  } finally {
    dek.fill(0);
  }
}

// --- Fields -----------------------------------------------------------------

// Which column a value belongs to. Part of the AAD, so an encrypted SSN can't
// be moved into the tax ID column (or vice versa) and still decrypt.
export type FieldContext = "Client.taxId" | "CorpContact.ssn";

export function isEncryptedField(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(FIELD_PREFIX);
}

export function encryptField(plaintext: string, context: FieldContext, ring: KeyRing = keyRing()): string {
  const key = subkey(masterKey(ring, ring.activeId), "field");
  const { iv, ct, tag } = gcmEncrypt(key, Buffer.from(plaintext, "utf8"), `workflow:field:${context}`);
  return `${FIELD_PREFIX}${ring.activeId}:${iv.toString("base64url")}:${Buffer.concat([ct, tag]).toString("base64url")}`;
}

export function fieldKeyId(sealed: string): string | null {
  if (!isEncryptedField(sealed)) return null;
  return sealed.slice(FIELD_PREFIX.length).split(":")[0] || null;
}

export function decryptField(sealed: string, context: FieldContext, ring: KeyRing = keyRing()): string {
  if (!isEncryptedField(sealed)) {
    // Never hand back something that isn't ciphertext as if it had been
    // protected: legacy plaintext must go through the migration script.
    throw new Error("This value isn't encrypted yet — run `npm run security:encrypt -- --apply`.");
  }
  const [keyId, iv, ctTag] = sealed.slice(FIELD_PREFIX.length).split(":");
  if (!keyId || !iv || !ctTag) throw new IntegrityError();
  const buf = Buffer.from(ctTag, "base64url");
  if (buf.length < TAG_BYTES) throw new IntegrityError();
  const key = subkey(masterKey(ring, keyId), "field");
  return gcmDecrypt(
    key,
    Buffer.from(iv, "base64url"),
    buf.subarray(0, buf.length - TAG_BYTES),
    buf.subarray(buf.length - TAG_BYTES),
    `workflow:field:${context}`
  ).toString("utf8");
}

// Keyed hash for uniqueness and exact-match lookups. Input is normalized first
// so "12-3456789" and "123456789" index the same.
export function blindIndex(normalized: string, context: FieldContext, ring: KeyRing = keyRing()): string {
  return createHmac("sha256", subkey(ring.indexKey, "blind-index"))
    .update(`${context}\u0000${normalized}`)
    .digest("base64url");
}

// --- Whole blobs (backups) ----------------------------------------------------

// Same envelope as a file, serialized as JSON so an encrypted backup is still
// a .json file the existing upload/preview flow can read.
export type SealedBlob = {
  format: "workflow-encrypted";
  version: 1;
  purpose: string;
  keyId: string;
  wrappedKey: string;
  data: string; // base64 of the encrypted file body
};

export function sealBlob(plaintext: Buffer, purpose: string, ring: KeyRing = keyRing()): SealedBlob {
  const id = `blob:${purpose}`;
  const enc = encryptFile(plaintext, id, ring);
  return {
    format: "workflow-encrypted",
    version: 1,
    purpose,
    keyId: enc.keyId,
    wrappedKey: enc.wrappedKey,
    data: enc.body.toString("base64"),
  };
}

export function isSealedBlob(input: unknown): input is SealedBlob {
  if (!input || typeof input !== "object") return false;
  const b = input as Partial<SealedBlob>;
  return (
    b.format === "workflow-encrypted" &&
    b.version === 1 &&
    typeof b.purpose === "string" &&
    typeof b.keyId === "string" &&
    typeof b.wrappedKey === "string" &&
    typeof b.data === "string"
  );
}

export function openBlob(blob: SealedBlob, purpose: string, ring: KeyRing = keyRing()): Buffer {
  if (blob.purpose !== purpose) throw new IntegrityError();
  return decryptFile(
    Buffer.from(blob.data, "base64"),
    { documentId: `blob:${purpose}`, keyId: blob.keyId, wrappedKey: blob.wrappedKey },
    ring
  );
}
