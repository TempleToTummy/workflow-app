import { readFile } from "node:fs/promises";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { objectStore } from "@/lib/storage";
import { createBackup, restoreBackup, snapshotPath } from "@/lib/backup";
import { checkBackup, backupFilename } from "@/lib/backup-format";
import { recordAudit, actorFrom, AUDIT } from "@/lib/audit";

// Backup download and restore (Admin → Backup & Restore).
//
// This route is excluded from src/proxy.ts's matcher: the proxy buffers request
// bodies and truncates them past 10 MB, which would silently corrupt a restore
// upload. It authenticates itself instead — admin session required for every
// method — exactly like the other machine routes do.

async function requireAdminRequest() {
  const user = await getCurrentUser();
  if (!user) return { error: new Response("Sign in first.", { status: 401 }) };
  if (user.role !== "ADMIN") return { error: new Response("Only an admin can do that.", { status: 403 }) };
  return { user };
}

// GET /api/backup            → download a fresh backup
// GET /api/backup?files=1    → …including uploaded files
// GET /api/backup?snapshot=x → download a stored pre-restore snapshot
export async function GET(request: Request) {
  const auth = await requireAdminRequest();
  if (auth.error) return auth.error;
  const url = new URL(request.url);

  const snapshot = url.searchParams.get("snapshot");
  if (snapshot) {
    const file = snapshotPath(snapshot);
    if (!file) return new Response("Not found", { status: 404 });
    try {
      const bytes = await readFile(file);
      return new Response(new Uint8Array(bytes), {
        headers: {
          "Content-Type": "application/json",
          "Content-Disposition": `attachment; filename="${snapshot}"`,
          "Cache-Control": "no-store",
        },
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  }

  const includeFiles = url.searchParams.get("files") === "1";
  const label = `${auth.user.firstName} ${auth.user.lastName}`;
  const backup = await createBackup(prisma, { includeFiles, store: objectStore, createdBy: label });
  const body = JSON.stringify(backup);

  // Downloading a backup is taking a copy of every client's data, so it
  // leaves a trace like any other sensitive action.
  await recordAudit({
    entityType: "Backup",
    entityId: backup.createdAt,
    action: AUDIT.BACKUP_EXPORTED,
    summary: `Downloaded a full backup${includeFiles ? " including uploaded files" : ""} (${Math.round(
      body.length / 1024
    )} KB)`,
    actor: actorFrom(auth.user),
  });

  return new Response(body, {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="${backupFilename()}"`,
      "Cache-Control": "no-store",
    },
  });
}

// POST multipart/form-data: file=<backup.json>, mode=preview|restore,
// confirm=RESTORE (restore only). Preview checks the file and reports what's
// in it without changing anything.
export async function POST(request: Request) {
  const auth = await requireAdminRequest();
  if (auth.error) return auth.error;

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ ok: false, error: "Upload a backup file." }, { status: 400 });
  }
  const file = form.get("file");
  const mode = String(form.get("mode") ?? "preview");
  if (!(file instanceof File) || file.size === 0) {
    return Response.json({ ok: false, error: "Choose a backup file." }, { status: 400 });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    return Response.json({ ok: false, error: "That file isn't valid JSON — is it a backup?" }, { status: 400 });
  }
  const check = checkBackup(parsed);
  if (!check.ok) return Response.json({ ok: false, error: check.error }, { status: 400 });

  if (mode !== "restore") {
    return Response.json({
      ok: true,
      preview: {
        counts: check.counts,
        fileCount: check.fileCount,
        createdAt: check.createdAt,
        createdBy: check.createdBy,
      },
    });
  }

  if (String(form.get("confirm") ?? "") !== "RESTORE") {
    return Response.json({ ok: false, error: "Type RESTORE to confirm." }, { status: 400 });
  }

  try {
    const result = await restoreBackup(prisma, parsed, { store: objectStore });
    // Written AFTER the restore (which replaced the audit table), so the log
    // that survives says a restore happened, by whom, and from what.
    await recordAudit({
      entityType: "Backup",
      entityId: check.createdAt,
      action: AUDIT.BACKUP_RESTORED,
      summary: `Restored the backup made ${check.createdAt}${
        check.createdBy ? ` by ${check.createdBy}` : ""
      } — everyone was signed out${result.snapshot ? "; the previous data was snapshotted first" : ""}`,
      actor: actorFrom(auth.user),
    });
    return Response.json({
      ok: true,
      restored: { counts: result.counts, filesWritten: result.filesWritten, snapshot: result.snapshot?.split(/[\\/]/).pop() ?? null },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json(
      { ok: false, error: `The restore failed and nothing was changed: ${message}` },
      { status: 500 }
    );
  }
}
