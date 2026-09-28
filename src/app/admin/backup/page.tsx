import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { BackupPanel } from "@/components/backup-panel";
import { listSnapshots } from "@/lib/backup";
import { SUMMARY_TABLES } from "@/lib/backup-format";
import { formatBytes, formatDate } from "@/lib/dates";
import { encryptionStatus } from "@/lib/encryption";
import { objectStore } from "@/lib/storage";

// A backup older than a week is flagged. Outside the component because a
// render must not read the clock directly (react-hooks/purity).
function isRecent(date: Date | undefined): boolean {
  return date !== undefined && Date.now() - date.getTime() < 7 * 86_400_000;
}

// What the Data protection card needs: is encryption configured, where do
// files go, and is anything still stored the old, unencrypted way.
async function protectionStatus() {
  const encryption = encryptionStatus();
  let storage: string;
  try {
    storage = objectStore.driver === "supabase" ? "Supabase Storage (private bucket)" : "Local disk (development)";
  } catch (err) {
    storage = `Misconfigured — ${err instanceof Error ? err.message : String(err)}`;
  }
  const activeKey = encryption.ok ? encryption.activeKeyId : null;
  const [plainFiles, staleFiles, plainTaxIds, plainSsns] = await Promise.all([
    prisma.document.count({ where: { encKeyId: null } }),
    activeKey ? prisma.document.count({ where: { encKeyId: { not: null, notIn: [activeKey] } } }) : Promise.resolve(0),
    prisma.client.count({ where: { taxIdEncrypted: { not: null }, NOT: { taxIdEncrypted: { startsWith: "enc:" } } } }),
    prisma.corpContact.count({ where: { ssnEncrypted: { not: null }, NOT: { ssnEncrypted: { startsWith: "enc:" } } } }),
  ]);
  return { encryption, storage, plainFiles, staleFiles, plainTaxIds, plainSsns };
}

export default async function BackupPage() {
  const protection = await protectionStatus();
  const [snapshots, lastExport, ...counts] = await Promise.all([
    listSnapshots(),
    prisma.auditEvent.findFirst({
      where: { action: "backup.exported" },
      orderBy: { createdAt: "desc" },
    }),
    prisma.client.count(),
    prisma.employee.count(),
    prisma.project.count(),
    prisma.clientActivity.count(),
    prisma.document.count(),
    prisma.timeEntry.count(),
    prisma.emailMessage.count(),
    prisma.auditEvent.count(),
  ]);
  const current = Object.fromEntries(SUMMARY_TABLES.map((t, i) => [t.table, counts[i]]));

  return (
    <div className="mx-auto w-full max-w-4xl px-8 py-8">
      <Link href="/" className="text-sm text-ink-muted hover:text-accent">
        ← Back to home
      </Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">Backup &amp; Restore</h1>
      <p className="mt-1 text-sm text-ink-muted">
        A backup is a single file with every client, task, file record, time entry, email and history
        entry. Keep one somewhere other than this server. The same file restores into SQLite or Postgres.
      </p>

      <div
        className={`mt-4 rounded-lg border px-4 py-3 text-sm ${
          isRecent(lastExport?.createdAt)
            ? "border-line bg-surface text-ink-muted"
            : "border-[var(--status-review)]/40 bg-[var(--status-review)]/10 text-ink"
        }`}
      >
        {lastExport
          ? `Last backup downloaded ${formatDate(lastExport.createdAt)} by ${lastExport.actorLabel}.`
          : "No backup has been downloaded from this app yet."}
        {!isRecent(lastExport?.createdAt) && (
          <>
            {" "}It&apos;s worth taking one now — and on a schedule with{" "}
            <code className="rounded bg-black/5 px-1 py-0.5 font-mono text-xs">npm run db:backup</code>.
          </>
        )}
      </div>

      <DataProtection {...protection} />

      <BackupPanel current={current} summary={SUMMARY_TABLES} />

      <div className="mt-8 rounded-lg border border-line bg-surface p-6">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-muted">Automatic snapshots</h2>
        <p className="mt-1 text-sm text-ink-muted">
          Every restore first saves the data it is about to replace, so restoring the wrong file can be
          undone by restoring the snapshot.
        </p>
        {snapshots.length === 0 ? (
          <p className="mt-4 rounded-md border border-dashed border-line px-3 py-6 text-center text-sm text-ink-muted">
            No snapshots yet.
          </p>
        ) : (
          <table className="mt-4 w-full text-left text-sm">
            <thead>
              <tr className="border-b border-line text-xs uppercase tracking-wide text-ink-muted">
                <th className="py-2 font-medium">File</th>
                <th className="py-2 font-medium">Size</th>
                <th className="py-2 font-medium">Saved</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {snapshots.map((s) => (
                <tr key={s.name} className="border-b border-line last:border-0">
                  <td className="py-2 font-mono text-xs">{s.name}</td>
                  <td className="tabular py-2 text-ink-muted">{formatBytes(s.size)}</td>
                  <td className="py-2 text-ink-muted">{s.modifiedAt.toLocaleString()}</td>
                  <td className="py-2 text-right">
                    <a
                      href={`/api/backup?snapshot=${encodeURIComponent(s.name)}`}
                      className="text-accent hover:underline"
                    >
                      Download
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function DataProtection({
  encryption,
  storage,
  plainFiles,
  staleFiles,
  plainTaxIds,
  plainSsns,
}: Awaited<ReturnType<typeof protectionStatus>>) {
  const pending = plainFiles + staleFiles + plainTaxIds + plainSsns;
  const healthy = encryption.ok && !encryption.development && pending === 0;
  const row = (label: string, value: string, bad = false) => (
    <div className="flex justify-between gap-4 py-1">
      <dt className="text-ink-muted">{label}</dt>
      <dd className={bad ? "font-medium text-overdue" : "text-ink"}>{value}</dd>
    </div>
  );
  return (
    <div
      className={`mt-4 rounded-lg border p-6 text-sm ${
        healthy ? "border-line bg-surface" : "border-overdue/40 bg-overdue/5"
      }`}
    >
      <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-muted">Data protection</h2>
      <p className="mt-1 text-ink-muted">
        Uploaded files, tax IDs, SSNs and backups are encrypted with AES-256-GCM before they are stored.
        The keys live only in this server&apos;s environment.
      </p>
      <dl className="mt-3">
        {row(
          "Encryption keys",
          !encryption.ok
            ? encryption.error
            : encryption.development
            ? "DEVELOPMENT key — not secret. Never use with real client data."
            : `Configured (active key "${encryption.activeKeyId}", ${encryption.keyCount} in ring)`,
          !encryption.ok || encryption.development
        )}
        {row("File storage", storage, storage.startsWith("Misconfigured"))}
        {row("Files not yet encrypted", String(plainFiles), plainFiles > 0)}
        {row("Files on an older key", String(staleFiles), staleFiles > 0)}
        {row("Tax IDs not yet encrypted", String(plainTaxIds), plainTaxIds > 0)}
        {row("SSNs not yet encrypted", String(plainSsns), plainSsns > 0)}
      </dl>
      {pending > 0 && (
        <p className="mt-3 text-ink">
          Run{" "}
          <code className="rounded bg-black/5 px-1 py-0.5 font-mono text-xs">npm run security:encrypt -- --apply</code>{" "}
          on the server to finish encrypting. Unencrypted files can&apos;t be downloaded until then.
        </p>
      )}
    </div>
  );
}
