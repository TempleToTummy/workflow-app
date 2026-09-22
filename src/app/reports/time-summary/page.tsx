import Link from "next/link";
import { ReportHeader } from "@/components/report-header";
import { timeRollups, type GroupedRollup } from "@/lib/time-data";
import {
  isTimeRange,
  formatMinutes,
  formatMoney,
  realizationPercent,
  TIME_RANGES,
  TIME_RANGE_LABELS,
  type TimeRangeKey,
} from "@/lib/time";

// The billing report: hours per employee, per client and per service, with
// realization and value. Admin-only through the reports layout, which is right
// — it is the firm's commercial picture.
//
// Two figures are deliberately allowed to be blank rather than zero:
//   - Realization for an empty range. 0/0 is not 0%.
//   - Value where no billing rate was in force. A rate nobody entered is
//     unknown, not free, and "$0.00" against a partner's week would be a lie
//     the report tells confidently.
export default async function TimeSummaryPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const params = await searchParams;
  const rangeKey: TimeRangeKey = isTimeRange(params.range) ? params.range : "this-month";
  const data = await timeRollups({ range: rangeKey });
  const realization = realizationPercent(data.total);

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-10">
      <Link href="/" className="no-print text-sm text-ink-muted hover:text-accent">
        ← Back to home
      </Link>
      <ReportHeader
        title="Time Summary"
        description="Hours, realization and value — by employee, by client and by service."
        reportKey="time-summary"
        query={{ range: rangeKey }}
      >
        <div className="no-print mt-3 flex flex-wrap items-center gap-1.5">
          {TIME_RANGES.map((key) => (
            <Link
              key={key}
              href={key === "this-month" ? "/reports/time-summary" : `/reports/time-summary?range=${key}`}
              aria-current={key === rangeKey ? "page" : undefined}
              className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                key === rangeKey
                  ? "border-accent bg-accent-soft text-accent"
                  : "border-line text-ink-muted hover:border-ink-muted/40 hover:text-ink"
              }`}
            >
              {TIME_RANGE_LABELS[key]}
            </Link>
          ))}
        </div>
      </ReportHeader>

      <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label={`Total · ${data.range.label}`} value={formatMinutes(data.total.totalMinutes)} />
        <Stat label="Billable" value={formatMinutes(data.total.billableMinutes)} />
        <Stat label="Non-billable" value={formatMinutes(data.total.nonBillableMinutes)} />
        <Stat
          label="Realization"
          value={realization === null ? "—" : `${realization}%`}
          hint={realization === null ? "Nothing logged in this range" : "Billable ÷ total"}
        />
      </div>

      {data.total.amount !== null && data.total.ratedMinutes < data.total.totalMinutes && (
        <p className="mt-3 rounded-md border border-[var(--status-review)]/30 bg-[var(--status-review-soft)] px-3 py-2 text-xs text-[var(--status-review)]">
          Value covers {formatMinutes(data.total.ratedMinutes)} of{" "}
          {formatMinutes(data.total.totalMinutes)} — the rest was logged by people with no
          billing rate on file. Set rates in Admin → Employees.
        </p>
      )}
      {data.total.amount === null && data.total.totalMinutes > 0 && (
        <p className="mt-3 rounded-md border border-line bg-surface px-3 py-2 text-xs text-ink-muted">
          No billing rates are set, so hours are shown without a value. Set them in
          Admin → Employees; existing entries keep whatever rate applied when they were
          logged.
        </p>
      )}

      <RollupTable heading="By employee" groups={data.byEmployee} total={data.total.totalMinutes} />
      <RollupTable heading="By client" groups={data.byClient} total={data.total.totalMinutes} />
      <RollupTable heading="By service" groups={data.byProject} total={data.total.totalMinutes} />

      {data.entries.length === 0 && (
        <p className="mt-6 rounded-lg border border-dashed border-line px-4 py-10 text-center text-sm text-ink-muted">
          No time logged in {data.range.label.toLowerCase()}.
        </p>
      )}
    </div>
  );
}

function RollupTable({
  heading,
  groups,
  total,
}: {
  heading: string;
  groups: GroupedRollup[];
  total: number;
}) {
  if (groups.length === 0) return null;

  return (
    <div className="print-block mt-6">
      <h2 className="text-sm font-semibold tracking-wide text-ink-muted uppercase">{heading}</h2>
      <div className="mt-2 overflow-hidden rounded-lg border border-line bg-surface">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-line bg-black/[0.02] text-xs tracking-wide text-ink-muted uppercase">
              <th className="px-4 py-2.5 font-medium">Name</th>
              <th className="px-4 py-2.5 text-right font-medium">Total</th>
              <th className="px-4 py-2.5 text-right font-medium">Billable</th>
              <th className="px-4 py-2.5 text-right font-medium">Realization</th>
              <th className="px-4 py-2.5 text-right font-medium">Value</th>
              <th className="px-4 py-2.5 text-right font-medium">Share</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => {
              const realization = realizationPercent(g.rollup);
              const share = total > 0 ? Math.round((g.rollup.totalMinutes / total) * 100) : 0;
              return (
                <tr key={g.key} className="border-b border-line last:border-0">
                  <td className="px-4 py-2.5 text-ink">{g.label}</td>
                  <td className="tabular px-4 py-2.5 text-right text-ink">
                    {formatMinutes(g.rollup.totalMinutes)}
                  </td>
                  <td className="tabular px-4 py-2.5 text-right text-ink-muted">
                    {formatMinutes(g.rollup.billableMinutes)}
                  </td>
                  <td className="tabular px-4 py-2.5 text-right text-ink-muted">
                    {realization === null ? "—" : `${realization}%`}
                  </td>
                  <td className="tabular px-4 py-2.5 text-right text-ink-muted">
                    {formatMoney(g.rollup.amount)}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <span className="flex items-center justify-end gap-2">
                      <span className="h-1.5 w-20 overflow-hidden rounded-full bg-black/5">
                        <span
                          className="block h-full rounded-full bg-accent"
                          style={{ width: `${share}%` }}
                        />
                      </span>
                      <span className="tabular w-9 text-right text-xs text-ink-muted">
                        {share}%
                      </span>
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="print-block rounded-lg border border-line bg-surface p-4">
      <p className="text-xs tracking-wide text-ink-muted uppercase">{label}</p>
      <p className="tabular mt-1.5 text-xl font-semibold text-ink">{value}</p>
      {hint && <p className="mt-1 text-[11px] text-ink-muted">{hint}</p>}
    </div>
  );
}
