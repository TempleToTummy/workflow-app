import { prisma } from "@/lib/prisma";
import { objectStore } from "@/lib/storage";
import { getCurrentUser } from "@/lib/auth";

// Serves a stored Document's bytes. The Files tab links here; the browser gets
// a download prompt. Bytes come from whatever ObjectStore is wired up in
// src/lib/storage.ts (local disk today).
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!(await getCurrentUser())) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { id } = await params;

  const doc = await prisma.document.findUnique({ where: { id } });
  if (!doc) {
    return new Response("Not found", { status: 404 });
  }

  let bytes: Buffer;
  try {
    bytes = await objectStore.get(doc.bucket, doc.storageKey);
  } catch {
    return new Response("File is missing from storage", { status: 410 });
  }

  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": doc.mimeType,
      "Content-Length": String(doc.size),
      "Content-Disposition": `attachment; filename="${encodeURIComponent(doc.filename)}"`,
    },
  });
}
