"use client";

import { useState } from "react";

type Counts = Record<string, number>;
type Preview = { counts: Counts; fileCount: number; createdAt: string; createdBy: string | null };

export function BackupPanel({
  current,
  summary,
}: {
  current: Counts;
  summary: { table: string; label: string }[];
}) {
  const [includeFiles, setIncludeFiles] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState<"checking" | "restoring" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ snapshot: string | null; filesWritten: number } | null>(null);

  async function send(mode: "preview" | "restore") {
    if (!file) return;
    setError(null);
    setBusy(mode === "preview" ? "checking" : "restoring");
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("mode", mode);
      if (mode === "restore") form.set("confirm", confirm);
      const res = await fetch("/api/backup", { method: "POST", body: form });
      const data = await res.json().catch(() => ({ ok: false, error: `The server answered ${res.status}.` }));
      if (!data.ok) {
        setError(data.error ?? "That didn't work.");
        if (mode === "preview") setPreview(null);
        return;
      }
      if (mode === "preview") setPreview(data.preview);
      else setDone({ snapshot: data.restored.snapshot, filesWritten: data.restored.filesWritten });
    } catch {
      setError("Couldn't reach the server.");
    } finally {
      setBusy(null);
    }
  }

  if (done) {
    return (
      <div className="mt-6 rounded-lg border border-accent/30 bg-accent-soft p-6">
        <h2 className="text-base font-semibold text-accent">Restore complete</h2>
        <p className="mt-2 text-sm text-ink">
          The data now matches the backup{done.filesWritten > 0 ? `, and ${done.filesWritten} files were written back` : ""}.
          Everyone — including you — has been signed out, because sign-ins don&apos;t carry across a restore.
        </p>
        {done.snapshot && (
          <p className="mt-1 text-sm text-ink-muted">
            The data that was replaced is saved as <span className="font-mono text-xs">{done.snapshot}</span>.
          </p>
        )}
        <a
          href="/login"
          className="mt-4 inline-block rounded-full bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90"
        >
          Sign in again
        </a>
      </div>
    );
  }

  return (
    <div className="mt-6 grid grid-cols-1 gap-6 md:grid-cols-2">
      <div className="rounded-lg border border-line bg-surface p-6">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-muted">Download a backup</h2>
        <p className="mt-2 text-sm text-ink-muted">
          Everything in the database. Sign-in sessions and pending invite/reset links are left out.
        </p>
        <label className="mt-4 flex items-start gap-2 text-sm text-ink">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={includeFiles}
            onChange={(e) => setIncludeFiles(e.target.checked)}
          />
          <span>
            Include uploaded files
            <span className="block text-xs text-ink-muted">
              Makes the backup complete on its own, but much larger ({current.Document ?? 0} files).
            </span>
          </span>
        </label>
        <a
          href={`/api/backup${includeFiles ? "?files=1" : ""}`}
          className="mt-4 inline-block rounded-full bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90"
        >
          Download backup
        </a>
        <p className="mt-3 text-xs text-ink-muted">
          The file contains client tax IDs, contacts and password hashes. Store it like you would the
          database itself.
        </p>
      </div>

      <div className="rounded-lg border border-line bg-surface p-6">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-muted">Restore from a backup</h2>
        <p className="mt-2 text-sm text-ink-muted">
          Replaces <strong className="text-ink">all</strong> current data with the file&apos;s. The current
          data is snapshotted first.
        </p>
        <input
          type="file"
          accept="application/json,.json"
          aria-label="Backup file"
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            setPreview(null);
            setConfirm("");
            setError(null);
          }}
          className="mt-4 block w-full text-sm text-ink file:mr-3 file:rounded-full file:border file:border-line file:bg-surface file:px-3 file:py-1 file:text-xs file:font-medium file:text-ink hover:file:bg-black/5"
        />
        {!preview && (
          <button
            type="button"
            disabled={!file || busy !== null}
            onClick={() => send("preview")}
            className="mt-3 rounded-full border border-line px-4 py-2 text-sm font-medium text-ink hover:bg-black/5 disabled:opacity-50"
          >
            {busy === "checking" ? "Checking…" : "Check file"}
          </button>
        )}

        {preview && (
          <div className="mt-4">
            <p className="text-xs text-ink-muted">
              Made {new Date(preview.createdAt).toLocaleString()}
              {preview.createdBy ? ` by ${preview.createdBy}` : ""}
              {preview.fileCount > 0 ? ` · includes ${preview.fileCount} files` : " · no uploaded files included"}
            </p>
            <table className="mt-2 w-full text-sm">
              <thead>
                <tr className="text-xs text-ink-muted">
                  <th className="py-1 text-left font-medium" />
                  <th className="py-1 text-right font-medium">Now</th>
                  <th className="py-1 text-right font-medium">After restore</th>
                </tr>
              </thead>
              <tbody>
                {summary.map((s) => {
                  const now = current[s.table] ?? 0;
                  const after = preview.counts[s.table] ?? 0;
                  return (
                    <tr key={s.table} className="border-t border-line">
                      <td className="py-1 text-ink">{s.label}</td>
                      <td className="tabular py-1 text-right text-ink-muted">{now}</td>
                      <td
                        className={`tabular py-1 text-right ${after < now ? "font-medium text-overdue" : "text-ink"}`}
                      >
                        {after}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <label className="mt-4 block text-sm text-ink">
              Type <span className="font-mono font-semibold">RESTORE</span> to replace all current data:
              <input
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="off"
                className="mt-1 w-full rounded-md border border-line bg-surface px-2 py-1.5 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-overdue/40"
              />
            </label>
            <button
              type="button"
              disabled={confirm !== "RESTORE" || busy !== null}
              onClick={() => send("restore")}
              className="mt-3 rounded-full bg-overdue px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-40"
            >
              {busy === "restoring" ? "Restoring… don't close this page" : "Restore this backup"}
            </button>
          </div>
        )}
        {error && <p className="mt-3 text-sm text-overdue">{error}</p>}
      </div>
    </div>
  );
}
