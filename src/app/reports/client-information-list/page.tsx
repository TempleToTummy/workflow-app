import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { ReportHeader } from "@/components/report-header";

export default async function ClientInformationListPage() {
  const clients = await prisma.client.findMany({
    where: { archivedAt: null },
    include: { corpType: true, businessType: true },
    orderBy: { companyName: "asc" },
  });

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-10">
      <Link href="/" className="no-print text-sm text-ink-muted hover:text-accent">
        ← Back to home
      </Link>
      <ReportHeader
        title="Client Information List"
        description="Every client's core details, in one table."
        reportKey="client-information-list"
      />

      <div className="mt-6 overflow-x-auto rounded-lg border border-line bg-surface">
        <table className="w-full min-w-[900px] text-left text-sm">
          <thead>
            <tr className="border-b border-line bg-black/[0.02] text-xs uppercase tracking-wide text-ink-muted">
              <th className="px-4 py-3 font-medium">Client</th>
              <th className="px-4 py-3 font-medium">Group</th>
              <th className="px-4 py-3 font-medium">Corp Type</th>
              <th className="px-4 py-3 font-medium">Business Type</th>
              <th className="px-4 py-3 font-medium">Tax ID</th>
              <th className="px-4 py-3 font-medium">Phone</th>
              <th className="px-4 py-3 font-medium">Email</th>
              <th className="px-4 py-3 font-medium">Address</th>
            </tr>
          </thead>
          <tbody>
            {clients.map((c) => (
              <tr key={c.id} className="border-b border-line last:border-0 hover:bg-black/[0.015]">
                <td className="px-4 py-3">
                  <Link href={`/clients/${c.id}`} className="font-medium text-ink hover:text-accent">
                    {c.companyName}
                  </Link>
                </td>
                <td className="px-4 py-3 text-ink-muted">{c.groupName ?? "—"}</td>
                <td className="px-4 py-3 text-ink-muted">{c.corpType?.name ?? "—"}</td>
                <td className="px-4 py-3 text-ink-muted">{c.businessType?.name ?? "—"}</td>
                <td className="px-4 py-3 text-ink-muted">{c.taxId ?? "—"}</td>
                <td className="px-4 py-3 text-ink-muted">{c.phone ?? "—"}</td>
                <td className="px-4 py-3 text-ink-muted">{c.email ?? "—"}</td>
                <td className="px-4 py-3 text-ink-muted">
                  {[c.address1, c.address2, c.city, c.state, c.zipcode].filter(Boolean).join(", ") ||
                    "—"}
                </td>
              </tr>
            ))}
            {clients.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-10 text-center text-ink-muted">
                  No clients yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
