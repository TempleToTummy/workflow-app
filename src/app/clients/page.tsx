import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { requireUser, assigneeScope } from "@/lib/auth";

export default async function ClientsPage() {
  const user = await requireUser();
  const mine = assigneeScope(user);
  const clients = await prisma.client.findMany({
    // Employees see only clients they have a task on.
    where: mine ? { activities: { some: { assigneeId: mine } } } : undefined,
    include: { businessType: true },
    orderBy: { companyName: "asc" },
  });

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-10">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Client Project Information</h1>
          <p className="mt-1 text-sm text-ink-muted">
            {mine
              ? "Clients you have work assigned on. Click one to see contacts and projects."
              : "Every client on file. Click one to see contacts and assigned projects."}
          </p>
        </div>
        <Link
          href="/clients/new"
          className="rounded-full bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90"
        >
          New Client
        </Link>
      </div>

      <div className="mt-6 overflow-hidden rounded-lg border border-line bg-surface">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-line bg-black/[0.02] text-xs uppercase tracking-wide text-ink-muted">
              <th className="px-4 py-3 font-medium">Client</th>
              <th className="px-4 py-3 font-medium">Business Type</th>
              <th className="px-4 py-3 font-medium">Phone</th>
              <th className="px-4 py-3 font-medium">Email</th>
            </tr>
          </thead>
          <tbody>
            {clients.map((c) => (
              <tr
                key={c.id}
                className="border-b border-line last:border-0 hover:bg-black/[0.015]"
              >
                <td className="px-4 py-3">
                  <Link
                    href={`/clients/${c.id}`}
                    className="font-medium text-ink hover:text-accent"
                  >
                    {c.companyName}
                  </Link>
                </td>
                <td className="px-4 py-3 text-ink-muted">{c.businessType?.name ?? "—"}</td>
                <td className="px-4 py-3 text-ink-muted">{c.phone ?? "—"}</td>
                <td className="px-4 py-3 text-ink-muted">{c.email ?? "—"}</td>
              </tr>
            ))}
            {clients.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-10 text-center text-ink-muted">
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
