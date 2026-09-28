import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

// --- Where file bytes live ----------------------------------------------------
//
// Every file the app stores is addressed by a (bucket, key) pair, exactly like
// an S3 / Supabase Storage object. The Document row holds that address; the
// bytes live wherever the ObjectStore below puts them.
//
// WHAT IS STORED IS ALWAYS CIPHERTEXT. Files are encrypted before they reach
// an ObjectStore and decrypted after they leave it (src/lib/document-vault.ts),
// so neither driver ever sees a readable file, and neither does anybody with
// access to the bucket — Supabase staff, a leaked service key, a misconfigured
// bucket policy, a stale replica. The bucket is a second line of defence, not
// the first.
//
// Two drivers, chosen by STORAGE_DRIVER (default: "supabase" when SUPABASE_URL
// is set, otherwise "local"):
//
//   local     ./.storage/<bucket>/<key> on this machine. Zero setup, for
//             development. Gitignored.
//   supabase  A PRIVATE Supabase Storage bucket, via its REST API with the
//             service-role key. No SDK dependency: three HTTP calls. Create
//             and lock down the bucket with supabase/security.sql first.

export interface ObjectStore {
  readonly driver: "local" | "supabase";
  put(bucket: string, key: string, body: Buffer): Promise<void>;
  get(bucket: string, key: string): Promise<Buffer>;
  remove(bucket: string, key: string): Promise<void>;
}

// Object keys are opaque: client id + document id, nothing else. The original
// filename ("Smith SSN card.jpg") is on the database row only — never in the
// object path, where it would show up in storage logs, the Supabase dashboard
// and any bucket listing.
export function documentStorageKey(clientId: string, documentId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(clientId) || !/^[A-Za-z0-9_-]+$/.test(documentId)) {
    throw new Error("Invalid storage key.");
  }
  return `clients/${clientId}/${documentId}.enc`;
}

export const DEFAULT_BUCKET = process.env.STORAGE_BUCKET?.trim() || "workflow-files";

const KEY_SHAPE = /^[A-Za-z0-9/_.-]+$/;
function assertKey(bucket: string, key: string) {
  if (!/^[a-z0-9][a-z0-9_-]{1,62}$/.test(bucket)) throw new Error("Invalid storage bucket.");
  if (!KEY_SHAPE.test(key) || key.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error("Invalid storage key.");
  }
}

// --- Local disk ---------------------------------------------------------------

class LocalObjectStore implements ObjectStore {
  readonly driver = "local" as const;
  private root = path.join(process.cwd(), ".storage");

  private resolve(bucket: string, key: string): string {
    assertKey(bucket, key);
    // Belt and braces: even a key that passed the shape check must resolve
    // inside the bucket directory.
    const bucketRoot = path.join(this.root, bucket);
    const full = path.join(bucketRoot, key);
    if (!full.startsWith(bucketRoot + path.sep)) throw new Error("Invalid storage key.");
    return full;
  }

  async put(bucket: string, key: string, body: Buffer): Promise<void> {
    const full = this.resolve(bucket, key);
    // Owner-only permissions: other accounts on the machine can't list or read.
    await mkdir(path.dirname(full), { recursive: true, mode: 0o700 });
    await writeFile(full, body, { mode: 0o600 });
  }

  async get(bucket: string, key: string): Promise<Buffer> {
    return readFile(this.resolve(bucket, key));
  }

  async remove(bucket: string, key: string): Promise<void> {
    await rm(this.resolve(bucket, key), { force: true });
  }
}

// --- Supabase Storage -----------------------------------------------------------

class SupabaseObjectStore implements ObjectStore {
  readonly driver = "supabase" as const;
  private base: string;
  private secret: string;

  constructor(url: string, secret: string) {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
      throw new Error("SUPABASE_URL must be https.");
    }
    this.base = `${parsed.origin}/storage/v1`;
    this.secret = secret;
  }

  private objectPath(bucket: string, key: string): string {
    assertKey(bucket, key);
    return `${encodeURIComponent(bucket)}/${key.split("/").map(encodeURIComponent).join("/")}`;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { apikey: this.secret, Authorization: `Bearer ${this.secret}`, ...extra };
  }

  private async fail(res: Response, op: string): Promise<never> {
    // Supabase's error body names the bucket/key and a reason; neither is
    // sensitive (keys are opaque ids), and it's what an operator needs.
    const detail = await res.text().catch(() => "");
    throw new Error(`Storage ${op} failed (${res.status}): ${detail.slice(0, 300)}`);
  }

  async put(bucket: string, key: string, body: Buffer): Promise<void> {
    const res = await fetch(`${this.base}/object/${this.objectPath(bucket, key)}`, {
      method: "POST",
      headers: this.headers({
        "Content-Type": "application/octet-stream",
        // Keys are unique per document, so an overwrite only happens when a
        // backup is restored onto the same objects — which should succeed.
        "x-upsert": "true",
        "Cache-Control": "no-store",
      }),
      body: new Uint8Array(body),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) await this.fail(res, "upload");
  }

  async get(bucket: string, key: string): Promise<Buffer> {
    const res = await fetch(`${this.base}/object/authenticated/${this.objectPath(bucket, key)}`, {
      headers: this.headers(),
      cache: "no-store",
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) await this.fail(res, "download");
    return Buffer.from(await res.arrayBuffer());
  }

  async remove(bucket: string, key: string): Promise<void> {
    assertKey(bucket, key);
    const res = await fetch(`${this.base}/object/${encodeURIComponent(bucket)}`, {
      method: "DELETE",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ prefixes: [key] }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) await this.fail(res, "delete");
  }
}

// --- Selection --------------------------------------------------------------------

// Server-only secrets must never be exposed to the browser bundle. Next inlines
// any NEXT_PUBLIC_* variable into client JavaScript, so refuse to start if one
// of these has been given that prefix by mistake.
const SERVER_ONLY_SECRETS = ["SERVICE_ROLE", "SUPABASE_SECRET", "DATA_ENCRYPTION", "DATA_INDEX", "AUTH_SECRET"];
function assertNoPublicSecrets(env: NodeJS.ProcessEnv) {
  for (const name of Object.keys(env)) {
    if (name.startsWith("NEXT_PUBLIC_") && SERVER_ONLY_SECRETS.some((s) => name.includes(s))) {
      throw new Error(`${name} would be shipped to every browser. Remove the NEXT_PUBLIC_ prefix.`);
    }
  }
}

export function createObjectStore(env: NodeJS.ProcessEnv = process.env): ObjectStore {
  assertNoPublicSecrets(env);
  const url = env.SUPABASE_URL?.trim();
  const secret = (env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_SECRET_KEY)?.trim();
  const driver = env.STORAGE_DRIVER?.trim() || (url ? "supabase" : "local");

  if (driver === "supabase") {
    if (!url || !secret) {
      throw new Error("STORAGE_DRIVER=supabase needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
    }
    return new SupabaseObjectStore(url, secret);
  }
  if (driver === "local") return new LocalObjectStore();
  throw new Error(`Unknown STORAGE_DRIVER "${driver}" — use "supabase" or "local".`);
}

let instance: ObjectStore | null = null;

// Lazy, so a misconfiguration surfaces as an error on the first file
// operation (and in the admin status panel) rather than crashing every page.
export const objectStore: ObjectStore = {
  get driver() {
    return (instance ??= createObjectStore()).driver;
  },
  put: (bucket, key, body) => (instance ??= createObjectStore()).put(bucket, key, body),
  get: (bucket, key) => (instance ??= createObjectStore()).get(bucket, key),
  remove: (bucket, key) => (instance ??= createObjectStore()).remove(bucket, key),
};
