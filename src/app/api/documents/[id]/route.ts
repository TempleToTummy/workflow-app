import { prisma } from "@/lib/prisma";
import { objectStore } from "@/lib/storage";
import { getCurrentUser } from "@/lib/auth";
import { canAccessEngagement } from "@/lib/access";

// Serves a stored Document's bytes. The Files tab links here; the browser gets
// a download prompt. Bytes come from whatever ObjectStore is wired up in
// src/lib/storage.ts (local disk today).
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getCurrentUser();
  if (!user) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { id } = await params;

  // Same gate as the Files tab the link came from: an employee can download a
  // file only from an engagement they're assigned to. "Not found" either way,
  // so the route can't confirm which document ids exist.
  const doc = await prisma.document.findUnique({ where: { id } });
  if (!doc || !(await canAccessEngagement(user, doc.clientId, doc.projectId))) {
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
