import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { AccountingPeriodForm } from "@/components/accounting-period-form";
import { formatDueDate } from "@/lib/dates";

const RECURRING_LABELS: Record<string, string> = {
  MONTHLY: "Monthly",
  QUARTERLY: "Quarterly",
  ANNUAL: "Every Year",
  ONE_TIME: "One time only",
};

export default async function AccountingPeriodsPage() {
  const periods = await prisma.accountingPeriod.findMany({
    include: { recurring: true },
    orderBy: { startDate: "desc" },
  });

  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-10">
      <Link href="/" className="text-sm text-ink-muted hover:text-accent">
        ← Back to home
      </Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">
        Accounting Period Information
      </h1>
      <p className="mt-1 text-sm text-ink-muted">
        Periods are usually created automatically the first time a client is assigned to a
        service of that cadence. Add one by hand here if you need it ahead of time.
      </p>

      <div className="mt-6 rounded-lg border border-line bg-surface p-6">
        <AccountingPeriodForm />
      </div>

      <div className="mt-6 overflow-hidden rounded-lg border border-line bg-surface">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-line bg-black/[0.02] text-xs uppercase tracking-wide text-ink-muted">
              <th className="px-4 py-3 font-medium">Name</th>
              <th className="px-4 py-3 font-medium">Cadence</th>
              <th className="px-4 py-3 font-medium">Start</th>
              <th className="px-4 py-3 font-medium">End</th>
            </tr>
          </thead>
          <tbody>
            {periods.map((p) => (
              <tr key={p.name} className="border-b border-line last:border-0">
                <td className="px-4 py-3 font-medium text-ink">{p.name}</td>
                <td className="px-4 py-3 text-ink-muted">
                  {RECURRING_LABELS[p.recurring.type] ?? p.recurring.type}
                </td>
                <td className="px-4 py-3 text-ink-muted">{formatDueDate(p.startDate)}</td>
                <td className="px-4 py-3 text-ink-muted">{formatDueDate(p.endDate)}</td>
              </tr>
            ))}
            {periods.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-10 text-center text-ink-muted">
                  No periods yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
