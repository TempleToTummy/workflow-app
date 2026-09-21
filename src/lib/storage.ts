import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

// --- The single swap point between local simulation and real cloud storage ---
//
// Every file the app stores is addressed by a (bucket, key) pair, exactly like
// an S3 / Supabase Storage object. The Document model in prisma/schema.prisma
// holds that address; the bytes live wherever the ObjectStore below puts them.
//
// Today that's LocalObjectStore, which writes under ./.storage/<bucket>/<key>
// so the whole thing runs with zero setup and zero dependencies. When the app
// moves to Supabase (same time the Prisma datasource switches to postgresql),
// drop in a SupabaseObjectStore and change the one `objectStore` export below —
// nothing else, including the database rows, has to change:
//
//   import { createClient } from "@supabase/supabase-js";
//
//   class SupabaseObjectStore implements ObjectStore {
//     private sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);
//     async put(bucket: string, key: string, body: Buffer, contentType: string) {
//       const { error } = await this.sb.storage.from(bucket)
//         .upload(key, body, { contentType, upsert: true });
//       if (error) throw error;
//     }
//     async get(bucket: string, key: string) {
//       const { data, error } = await this.sb.storage.from(bucket).download(key);
//       if (error) throw error;
//       return Buffer.from(await data.arrayBuffer());
//     }
//     async remove(bucket: string, key: string) {
//       await this.sb.storage.from(bucket).remove([key]);
//     }
//   }

export interface ObjectStore {
  put(bucket: string, key: string, body: Buffer, contentType: string): Promise<void>;
  get(bucket: string, key: string): Promise<Buffer>;
  remove(bucket: string, key: string): Promise<void>;
}

// Local disk implementation. The `.storage` directory is disposable and
// gitignored; deleting it just clears the "bucket".
class LocalObjectStore implements ObjectStore {
  private root = path.join(process.cwd(), ".storage");

  private resolve(bucket: string, key: string): string {
    // Guard against keys trying to escape the bucket directory.
    const full = path.join(this.root, bucket, key);
    const bucketRoot = path.join(this.root, bucket);
    if (full !== bucketRoot && !full.startsWith(bucketRoot + path.sep)) {
      throw new Error("Invalid storage key.");
    }
    return full;
  }

  async put(bucket: string, key: string, body: Buffer): Promise<void> {
    const full = this.resolve(bucket, key);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, body);
  }

  async get(bucket: string, key: string): Promise<Buffer> {
    return readFile(this.resolve(bucket, key));
  }

  async remove(bucket: string, key: string): Promise<void> {
    await rm(this.resolve(bucket, key), { force: true });
  }
}

export const objectStore: ObjectStore = new LocalObjectStore();

export const DEFAULT_BUCKET = "workflow-files";

// Object key for a document: groups files by engagement, then by document id so
// two uploads with the same filename never collide.
export function documentStorageKey(
  clientId: string,
  projectId: string,
  documentId: string,
  filename: string
): string {
  const safe = filename.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120) || "file";
  return `assignments/${clientId}/${projectId}/${documentId}/${safe}`;
}
