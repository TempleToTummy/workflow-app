"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { deleteDocument, uploadDocument } from "@/lib/actions";
import { formatBytes, formatDate } from "@/lib/dates";

export type FileRow = {
  id: string;
  filename: string;
  size: number;
  uploadedByName: string | null;
  createdAt: string;
};

export function AssignmentFiles({
  clientId,
  projectId,
  periodName,
  documents,
}: {
  clientId: string;
  projectId: string;
  periodName: string | null;
  documents: FileRow[];
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const form = e.currentTarget;
    const data = new FormData(form);
    data.set("clientId", clientId);
    data.set("projectId", projectId);
    if (periodName) data.set("periodName", periodName);
    startTransition(async () => {
      try {
        await uploadDocument(data);
        form.reset();
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Upload failed.");
      }
    });
  }

  function handleDelete(id: string) {
    setError(null);
    startTransition(async () => {
      try {
        await deleteDocument(id);
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't delete.");
      }
    });
  }

  return (
    <div className="rounded-lg border border-line bg-surface p-6">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-muted">
        Files
      </h2>
      <p className="mt-1 text-sm text-ink-muted">
        Documents for this client and project.
      </p>

      <form
        ref={formRef}
        onSubmit={handleSubmit}
        className="mt-4 flex flex-wrap items-center gap-2"
      >
        <input
          type="file"
          name="file"
          required
          disabled={isPending}
          className="min-w-0 flex-1 text-sm text-ink file:mr-3 file:rounded-full file:border file:border-line file:bg-surface file:px-3 file:py-1 file:text-xs file:font-medium file:text-ink hover:file:bg-black/5"
        />
        <button
          type="submit"
          disabled={isPending}
          className="rounded-full bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {isPending ? "Working…" : "Upload"}
        </button>
      </form>
      {error && <p className="mt-2 text-xs text-overdue">{error}</p>}

      {documents.length === 0 ? (
        <div className="mt-4 rounded-lg border border-dashed border-line px-4 py-8 text-center text-sm text-ink-muted">
          No files uploaded yet.
        </div>
      ) : (
        <table className="mt-4 w-full text-left text-sm">
          <thead>
            <tr className="border-b border-line text-xs uppercase tracking-wide text-ink-muted">
              <th className="py-2 pr-4 font-medium">Name</th>
              <th className="py-2 pr-4 font-medium">Size</th>
              <th className="py-2 pr-4 font-medium">Uploaded by</th>
              <th className="py-2 pr-4 font-medium">Date</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody>
            {documents.map((doc) => (
              <tr key={doc.id} className="border-b border-line last:border-0">
                <td className="py-2 pr-4">
                  <a
                    href={`/api/documents/${doc.id}`}
                    className="font-medium text-ink hover:text-accent"
                  >
                    {doc.filename}
                  </a>
                </td>
                <td className="tabular py-2 pr-4 text-ink-muted">
                  {formatBytes(doc.size)}
                </td>
                <td className="py-2 pr-4 text-ink-muted">
                  {doc.uploadedByName ?? "—"}
                </td>
                <td className="tabular py-2 pr-4 text-ink-muted">
                  {formatDate(doc.createdAt)}
                </td>
                <td className="py-2 text-right">
                  <button
                    type="button"
                    onClick={() => handleDelete(doc.id)}
                    disabled={isPending}
                    aria-label="Delete file"
                    className="text-ink-muted hover:text-overdue disabled:opacity-50"
                  >
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
