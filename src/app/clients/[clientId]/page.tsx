import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { DeleteClientButton } from "@/components/delete-client-button";
import { AssignProjectPanel } from "@/components/assign-project-panel";
import { ContactManager } from "@/components/contact-manager";
import { requireUser, assigneeScope } from "@/lib/auth";
import { formatBytes, formatDate } from "@/lib/dates";
import { redirect } from "next/navigation";

const RECURRING_LABELS: Record<string, string> = {
  MONTHLY: "Monthly",
  QUARTERLY: "Quarterly",
  ANNUAL: "Annual",
  ONE_TIME: "One time",
};

export default async function ClientDetailPage({
  params,
}: {
  params: Promise<{ clientId: string }>;
}) {
  const user = await requireUser();
  const mine = assigneeScope(user);
  const { clientId } = await params;

  if (mine) {
    const onIt = await prisma.clientActivity.count({ where: { clientId, assigneeId: mine } });
    if (onIt === 0) redirect("/clients");
  }

  const [client, allProjects, documents, periods] = await Promise.all([
    prisma.client.findUnique({
      where: { id: clientId },
      include: {
        businessType: true,
        corpType: true,
        contacts: { orderBy: { createdAt: "asc" } },
        projectAssignments: { include: { project: true }, orderBy: { createdAt: "asc" } },
      },
    }),
    prisma.project.findMany({
      include: { recurring: true, _count: { select: { subtasks: true } } },
      orderBy: { name: "asc" },
    }),
    prisma.document.findMany({
      where: { clientId },
      include: { project: true, uploadedBy: true },
      orderBy: { createdAt: "desc" },
    }),
    prisma.accountingPeriod.findMany(),
  ]);

  if (!client) notFound();

  // Every file this client has, grouped project → period, so a finished
  // period's uploads are still findable after the engagement rolls forward.
  const periodStart = new Map(periods.map((p) => [p.name, p.startDate.getTime()]));
  const currentPeriodByProject = new Map(
    client.projectAssignments.map((a) => [a.projectId, a.currentPeriod])
  );
  type Doc = (typeof documents)[number];
  const fileGroups = [...documents.reduce((acc, d) => {
    const g = acc.get(d.projectId) ?? { projectId: d.projectId, name: d.project.name, periods: new Map<string, Doc[]>() };
    const key = d.periodName ?? "";
    g.periods.set(key, [...(g.periods.get(key) ?? []), d]);
    acc.set(d.projectId, g);
    return acc;
  }, new Map<string, { projectId: string; name: string; periods: Map<string, Doc[]> }>()).values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((g) => ({
      ...g,
      periods: [...g.periods.entries()].sort(
        ([a], [b]) => (periodStart.get(b) ?? -1) - (periodStart.get(a) ?? -1) || b.localeCompare(a)
      ),
    }));

  const assignedIds = new Set(client.projectAssignments.map((a) => a.projectId));
  const assignable = allProjects
    .filter((p) => !assignedIds.has(p.id))
    .map((p) => ({
      id: p.id,
      name: p.name,
      cadence: RECURRING_LABELS[p.recurring.type] ?? p.recurring.type,
      stepCount: p._count.subtasks,
    }));

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-10">
      <div className="flex items-center justify-between">
        <Link href="/clients" className="text-sm text-ink-muted hover:text-accent">
          ← Back to clients
        </Link>
        <DeleteClientButton clientId={client.id} clientName={client.companyName} />
      </div>

      <div className="mt-6 rounded-lg border border-line bg-surface p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-muted">
            Client
          </h2>
          <Link
            href={`/clients/${client.id}/edit`}
            className="rounded-full border border-line px-3 py-1 text-xs font-medium text-ink hover:bg-black/5"
          >
            Edit
          </Link>
        </div>
        <dl className="grid grid-cols-1 gap-x-8 gap-y-3 sm:grid-cols-2">
          <div>
            <dt className="text-xs text-ink-muted">Client Name</dt>
            <dd className="text-ink">{client.companyName}</dd>
          </div>
          <div>
            <dt className="text-xs text-ink-muted">Group Name</dt>
            <dd className="text-ink">{client.groupName ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-xs text-ink-muted">Corporation Type</dt>
            <dd className="text-ink">{client.corpType?.name ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-xs text-ink-muted">Business Type</dt>
            <dd className="text-ink">{client.businessType?.name ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-xs text-ink-muted">Phone No</dt>
            <dd className="text-ink">{client.phone ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-xs text-ink-muted">Fax</dt>
            <dd className="text-ink">{client.fax ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-xs text-ink-muted">Email Address</dt>
            <dd className="text-ink">{client.email ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-xs text-ink-muted">Tax ID (FIN)</dt>
            <dd className="text-ink">{client.taxId ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-xs text-ink-muted">Address</dt>
            <dd className="text-ink">
              {[client.address1, client.address2, client.city, client.state, client.zipcode]
                .filter(Boolean)
                .join(", ") || "—"}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-ink-muted">Registration Date</dt>
            <dd className="text-ink">
              {client.coRegDate ? client.coRegDate.toISOString().slice(0, 10) : "—"}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-ink-muted">Registration State</dt>
            <dd className="text-ink">{client.coRegState ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-xs text-ink-muted">Renewal Month</dt>
            <dd className="text-ink">{client.renewMonth ?? "—"}</dd>
          </div>
          {client.note && (
            <div className="sm:col-span-2">
              <dt className="text-xs text-ink-muted">Note</dt>
              <dd className="text-ink">{client.note}</dd>
            </div>
          )}
        </dl>
      </div>

      <div className="mt-6">
        <ContactManager
          clientId={client.id}
          contacts={client.contacts.map((c) => ({
            id: c.id,
            firstName: c.firstName,
            lastName: c.lastName,
            mobile: c.mobile,
            email: c.email,
            note: c.note,
          }))}
        />
      </div>

      <div className="mt-6 rounded-lg border border-line bg-surface p-6">
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-ink-muted">
          Projects
        </h2>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-line text-xs uppercase tracking-wide text-ink-muted">
              <th className="py-2 font-medium">Project</th>
              <th className="py-2 font-medium">Active</th>
              <th className="py-2 font-medium">Current Period</th>
              <th className="py-2 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {client.projectAssignments.map((a) => (
              <tr key={a.projectId} className="border-b border-line last:border-0">
                <td className="py-2">
                  <Link
                    href={`/projects/${a.projectId}`}
                    className="text-ink hover:text-accent"
                  >
                    {a.project.name}
                  </Link>
                </td>
                <td className="py-2 text-ink-muted">{a.active ? "Y" : "N"}</td>
                <td className="tabular py-2 text-ink-muted">{a.currentPeriod ?? "—"}</td>
                <td className="py-2 text-right">
                  <Link
                    href={`/assignments/${client.id}/${a.projectId}`}
                    className="text-accent hover:underline"
                  >
                    Open checklist
                  </Link>
                </td>
              </tr>
            ))}
            {client.projectAssignments.length === 0 && (
              <tr>
                <td colSpan={4} className="py-6 text-center text-ink-muted">
                  No projects assigned yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>

        <AssignProjectPanel clientId={client.id} projects={assignable} />
      </div>

      <div className="mt-6 rounded-lg border border-line bg-surface p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-muted">
            Files
            {documents.length > 0 && (
              <span className="tabular ml-2 rounded-full bg-black/5 px-1.5 py-0.5 text-[11px] normal-case tracking-normal">
                {documents.length}
              </span>
            )}
          </h2>
          <span className="text-xs text-ink-muted">Grouped by project, then period</span>
        </div>

        {fileGroups.length === 0 && (
          <p className="rounded-md border border-dashed border-line px-3 py-6 text-center text-sm text-ink-muted">
            No files yet. Upload from a project&apos;s Files tab and they&apos;ll show up here.
          </p>
        )}

        <div className="flex flex-col gap-5">
          {fileGroups.map((g) => (
            <div key={g.projectId}>
              <div className="mb-2 flex items-center justify-between">
                <Link
                  href={`/projects/${g.projectId}`}
                  className="text-sm font-semibold text-ink hover:text-accent"
                >
                  {g.name}
                </Link>
                <span className="tabular text-xs text-ink-muted">
                  {g.periods.reduce((n, [, docs]) => n + docs.length, 0)} files
                </span>
              </div>
              <div className="flex flex-col gap-2">
                {g.periods.map(([periodName, docs]) => {
                  const isCurrent = currentPeriodByProject.get(g.projectId) === periodName;
                  const q = new URLSearchParams({ tab: "files" });
                  if (periodName && !isCurrent) q.set("period", periodName);
                  return (
                    <div key={periodName || "none"} className="overflow-hidden rounded-md border border-line">
                      <div className="flex items-center justify-between border-b border-line bg-black/[0.02] px-3 py-1.5">
                        <span className="tabular text-xs font-medium text-ink-muted">
                          {periodName || "No period"}
                          {isCurrent && <span className="ml-1.5 font-sans text-accent">· current</span>}
                        </span>
                        <Link
                          href={`/assignments/${client.id}/${g.projectId}?${q.toString()}`}
                          className="text-xs text-accent hover:underline"
                        >
                          Open project →
                        </Link>
                      </div>
                      <ul>
                        {docs.map((d) => (
                          <li
                            key={d.id}
                            className="flex items-center justify-between gap-3 border-b border-line px-3 py-2 text-sm last:border-0"
                          >
                            <a
                              href={`/api/documents/${d.id}`}
                              className="min-w-0 truncate text-ink hover:text-accent"
                            >
                              {d.filename}
                            </a>
                            <span className="tabular shrink-0 text-xs text-ink-muted">
                              {formatBytes(d.size)}
                              {d.uploadedBy && ` · ${d.uploadedBy.firstName} ${d.uploadedBy.lastName}`}
                              {` · ${formatDate(d.createdAt)}`}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
