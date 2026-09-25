import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { formatDate } from "@/lib/dates";
import { SchedulerPanel } from "@/components/scheduler-panel";
import {
  PERIOD_GENERATION_JOB,
  STALE_AFTER_HOURS,
  lastSuccessfulRun,
} from "@/lib/scheduler";
import { currentPeriodName, isPeriodBefore } from "@/lib/periods";

// Work Generation — the operational view of the scheduled job that opens each
// engagement's accounting periods. Before this existed, the next period was
// only ever created as a side effect of someone finishing the previous one, so
// an engagement that fell behind quietly stopped producing work. This page is
// where you confirm the job is running and see what it did.

function timeAgo(date: Date, now: Date): string {
  const mins = Math.round((now.getTime() - date.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  return `${Math.round(hours / 24)} days ago`;
}

function duration(start: Date, end: Date | null): string {
  if (!end) return "—";
  const ms = end.getTime() - start.getTime();
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export default async function SchedulerPage() {
  const now = new Date();

  const [runs, last, assignments] = await Promise.all([
    prisma.schedulerRun.findMany({
      where: { job: PERIOD_GENERATION_JOB },
      orderBy: { startedAt: "desc" },
      take: 20,
    }),
    lastSuccessfulRun(),
    prisma.projectClientMap.findMany({
      // Archived clients are deliberately parked — not a scheduler problem.
      where: { active: true, client: { archivedAt: null } },
      include: {
        client: { select: { companyName: true } },
        project: { include: { recurring: true, _count: { select: { subtasks: true } } } },
      },
    }),
  ]);

  const stale =
    !last || now.getTime() - last.startedAt.getTime() > STALE_AFTER_HOURS * 3600_000;

  // Engagements parked in a period that has already passed. After a healthy
  // run this list is empty — anything left here is a real data problem (a
  // service with no checklist steps, usually), not a missed schedule.
  const behind = assignments
    .filter((a) => {
      const type = a.project.recurring.type;
      if (type === "ONE_TIME" || !a.currentPeriod) return false;
      return isPeriodBefore(type, a.currentPeriod, currentPeriodName(type, now));
    })
    .map((a) => ({
      key: `${a.clientId}:${a.projectId}`,
      clientId: a.clientId,
      projectId: a.projectId,
      clientName: a.client.companyName,
      projectName: a.project.name,
      parkedIn: a.currentPeriod!,
      shouldBe: currentPeriodName(a.project.recurring.type, now),
      reason:
        a.project._count.subtasks === 0
          ? "This service has no checklist steps yet."
          : "Will be opened on the next run.",
    }));

  return (
    <div className="mx-auto w-full max-w-6xl px-8 py-8">
      <Link href="/" className="text-sm text-ink-muted hover:text-accent">
        ← Back to home
      </Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">Work Generation</h1>
      <p className="mt-1 max-w-2xl text-sm text-ink-muted">
        A scheduled job opens the next accounting period for every active
        engagement and generates its checklist — it does not wait for the
        previous period to be finished. Point a daily cron at{" "}
        <code className="rounded bg-black/5 px-1 py-0.5 text-[12px]">
          /api/cron/generate-periods
        </code>{" "}
        with your <code className="rounded bg-black/5 px-1 py-0.5 text-[12px]">CRON_SECRET</code>{" "}
        as a bearer token.
      </p>

      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat
          label="Last successful run"
          value={last ? timeAgo(last.startedAt, now) : "Never"}
          tone={stale ? "bad" : "good"}
        />
        <Stat label="Engagements scanned" value={last ? String(last.engagementsScanned) : "—"} />
        <Stat label="Tasks generated" value={last ? String(last.activitiesCreated) : "—"} />
        <Stat
          label="Behind schedule"
          value={String(behind.length)}
          tone={behind.length > 0 ? "warn" : "good"}
        />
      </div>

      <div className="mt-4">
        <SchedulerPanel stale={stale} />
      </div>

      {behind.length > 0 && (
        <>
          <h2 className="mt-8 mb-3 text-sm font-semibold text-ink">
            Engagements behind the current period
          </h2>
          <div className="overflow-x-auto rounded-lg border border-line bg-surface">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-line bg-black/[0.02] text-xs uppercase tracking-wide text-ink-muted">
                  <th className="px-4 py-3 font-medium">Client</th>
                  <th className="px-4 py-3 font-medium">Service</th>
                  <th className="px-4 py-3 font-medium">Parked in</th>
                  <th className="px-4 py-3 font-medium">Should be</th>
                  <th className="px-4 py-3 font-medium">Why</th>
                </tr>
              </thead>
              <tbody>
                {behind.map((b) => (
                  <tr key={b.key} className="border-b border-line last:border-0">
                    <td className="px-4 py-3">
                      <Link
                        href={`/assignments/${b.clientId}/${b.projectId}`}
                        className="font-medium text-ink hover:text-accent"
                      >
                        {b.clientName}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-ink-muted">{b.projectName}</td>
                    <td className="tabular px-4 py-3 text-overdue">{b.parkedIn}</td>
                    <td className="tabular px-4 py-3 text-ink-muted">{b.shouldBe}</td>
                    <td className="px-4 py-3 text-ink-muted">{b.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <h2 className="mt-8 mb-3 text-sm font-semibold text-ink">Run history</h2>
      <div className="overflow-x-auto rounded-lg border border-line bg-surface">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-line bg-black/[0.02] text-xs uppercase tracking-wide text-ink-muted">
              <th className="px-4 py-3 font-medium">When</th>
              <th className="px-4 py-3 font-medium">Trigger</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Scanned</th>
              <th className="px-4 py-3 font-medium">Periods</th>
              <th className="px-4 py-3 font-medium">Tasks</th>
              <th className="px-4 py-3 font-medium">Took</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id} className="border-b border-line align-top last:border-0">
                <td className="px-4 py-3 text-ink-muted">
                  <div>{formatDate(r.startedAt)}</div>
                  <div className="text-[11px]">
                    {r.startedAt.toLocaleTimeString("en-US", {
                      hour: "numeric",
                      minute: "2-digit",
                    })}
                  </div>
                </td>
                <td className="px-4 py-3 text-ink-muted">{r.trigger}</td>
                <td className="px-4 py-3">
                  <span
                    className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                      r.status === "SUCCESS"
                        ? "bg-accent-soft text-accent"
                        : r.status === "RUNNING"
                        ? "bg-black/5 text-ink-muted"
                        : "bg-overdue/10 text-overdue"
                    }`}
                  >
                    {r.status.toLowerCase()}
                  </span>
                  {r.detail && (
                    <p className="mt-1 max-w-sm whitespace-pre-line text-[11px] text-ink-muted">
                      {r.detail}
                    </p>
                  )}
                </td>
                <td className="tabular px-4 py-3 text-ink-muted">{r.engagementsScanned}</td>
                <td className="tabular px-4 py-3 text-ink-muted">{r.periodsCreated}</td>
                <td className="tabular px-4 py-3 text-ink-muted">{r.activitiesCreated}</td>
                <td className="tabular px-4 py-3 text-ink-muted">
                  {duration(r.startedAt, r.finishedAt)}
                </td>
              </tr>
            ))}
            {runs.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-ink-muted">
                  The job hasn&apos;t run yet. Press Run now to generate this period&apos;s work.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
  tone?: "neutral" | "good" | "warn" | "bad";
}) {
  const valueClass =
    tone === "bad"
      ? "text-overdue"
      : tone === "warn"
      ? "text-[var(--status-review)]"
      : tone === "good"
      ? "text-accent"
      : "text-ink";
  return (
    <div className="rounded-lg border border-line bg-surface px-4 py-3">
      <p className="text-[11px] uppercase tracking-wide text-ink-muted">{label}</p>
      <p className={`mt-1 text-lg font-semibold ${valueClass}`}>{value}</p>
    </div>
  );
}
