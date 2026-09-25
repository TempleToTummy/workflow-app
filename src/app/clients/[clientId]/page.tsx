import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { ArchiveClientButton, ArchivedClientBanner } from "@/components/client-archive-controls";
import { ClientTagEditor } from "@/components/client-tag-editor";
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

  // An employee may be on one of this client's services and not another; the
  // file list below only shows files from engagements they can open.
  const myProjectIds = mine
    ? (
        await prisma.clientActivity.findMany({
          where: { clientId, assigneeId: mine },
          select: { projectId: true },
          distinct: ["projectId"],
        })
      ).map((r) => r.projectId)
    : null;
  const isAdmin = user.role === "ADMIN";

  const [client, allProjects, documents, periods, allTags] = await Promise.all([
    prisma.client.findUnique({
      where: { id: clientId },
      include: {
        tags: { include: { tag: true }, orderBy: { createdAt: "asc" } },
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
      where: { clientId, ...(myProjectIds ? { projectId: { in: myProjectIds } } : {}) },
      include: { project: true, uploadedBy: true },
      orderBy: { createdAt: "desc" },
    }),
    prisma.accountingPeriod.findMany(),
    prisma.tag.findMany({ orderBy: { name: "asc" } }),
  ]);

  if (!client) notFound();

  // Whether permanent deletion is possible, spelled out so the archived
  // banner can say why not before anyone clicks.
  let historySummary: string | null = null;
  if (client.archivedAt && isAdmin) {
    const [tasks, services, files, time, emails] = await Promise.all([
      prisma.clientActivity.count({ where: { clientId } }),
      prisma.projectClientMap.count({ where: { clientId } }),
      prisma.document.count({ where: { clientId } }),
      prisma.timeEntry.count({ where: { clientId } }),
      prisma.emailMessage.count({ where: { clientId } }),
    ]);
    const parts = [
      tasks && `${tasks} task${tasks === 1 ? "" : "s"}`,
      services && `${services} service${services === 1 ? "" : "s"}`,
      files && `${files} file${files === 1 ? "" : "s"}`,
      time && `${time} time entr${time === 1 ? "y" : "ies"}`,
      emails && `${emails} email${emails === 1 ? "" : "s"}`,
    ].filter(Boolean);
    historySummary = parts.length ? parts.join(", ") : null;
  }

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
    <div className="mx-auto w-full max-w-6xl px-8 py-8">
      <Link
        href={client.archivedAt ? "/clients?archived=1" : "/clients"}
        className="text-sm text-ink-muted hover:text-accent"
      >
        ← Back to clients
      </Link>
      {/* The client's name as the page title, like every other detail page,
          rather than leaving the page headed by a generic "Client" card. */}
      <div className="mt-2 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">{client.companyName}</h1>
          <p className="mt-1 text-sm text-ink-muted">
            {[client.groupName, client.corpType?.name, client.businessType?.name]
              .filter(Boolean)
              .join(" · ") || "Client details, contacts, projects and files."}
          </p>
        </div>
        {isAdmin && !client.archivedAt && (
          <ArchiveClientButton clientId={client.id} clientName={client.companyName} />
        )}
      </div>

      {client.archivedAt && (
        <ArchivedClientBanner
          clientId={client.id}
          clientName={client.companyName}
          archivedAt={client.archivedAt.toISOString()}
          archivedBy={client.archivedByLabel}
          canManage={isAdmin}
          historySummary={historySummary}
        />
      )}

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
        <dl className="grid grid-cols-1 gap-x-8 gap-y-4 text-sm sm:grid-cols-2">
          <div>
            <dt className="mb-0.5 text-xs text-ink-muted">Client Name</dt>
            <dd className="text-ink">{client.companyName}</dd>
          </div>
          <div>
            <dt className="mb-0.5 text-xs text-ink-muted">Group Name</dt>
            <dd className="text-ink">
              {client.groupName ? (
                <Link
                  href={`/clients?group=${encodeURIComponent(client.groupName)}`}
                  className="hover:text-accent"
                  title="See every client in this group"
                >
                  {client.groupName}
                </Link>
              ) : (
                "—"
              )}
            </dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="mb-1 text-xs text-ink-muted">Tags</dt>
            <dd>
              <ClientTagEditor
                clientId={client.id}
                canEdit
                tags={client.tags.map((ct) => ({ id: ct.tag.id, name: ct.tag.name, color: ct.tag.color }))}
                allTags={allTags.map((t) => ({ id: t.id, name: t.name, color: t.color }))}
              />
            </dd>
          </div>
          <div>
            <dt className="mb-0.5 text-xs text-ink-muted">Corporation Type</dt>
            <dd className="text-ink">{client.corpType?.name ?? "—"}</dd>
          </div>
          <div>
            <dt className="mb-0.5 text-xs text-ink-muted">Business Type</dt>
            <dd className="text-ink">{client.businessType?.name ?? "—"}</dd>
          </div>
          <div>
            <dt className="mb-0.5 text-xs text-ink-muted">Phone No</dt>
            <dd className="text-ink">{client.phone ?? "—"}</dd>
          </div>
          <div>
            <dt className="mb-0.5 text-xs text-ink-muted">Fax</dt>
            <dd className="text-ink">{client.fax ?? "—"}</dd>
          </div>
          <div>
            <dt className="mb-0.5 text-xs text-ink-muted">Email Address</dt>
            <dd className="text-ink">{client.email ?? "—"}</dd>
          </div>
          <div>
            <dt className="mb-0.5 text-xs text-ink-muted">Tax ID (FIN)</dt>
            <dd className="text-ink">{client.taxId ?? "—"}</dd>
          </div>
          <div>
            <dt className="mb-0.5 text-xs text-ink-muted">Address</dt>
            <dd className="text-ink">
              {[client.address1, client.address2, client.city, client.state, client.zipcode]
                .filter(Boolean)
                .join(", ") || "—"}
            </dd>
          </div>
          <div>
            <dt className="mb-0.5 text-xs text-ink-muted">Registration Date</dt>
            <dd className="text-ink">
              {client.coRegDate ? client.coRegDate.toISOString().slice(0, 10) : "—"}
            </dd>
          </div>
          <div>
            <dt className="mb-0.5 text-xs text-ink-muted">Registration State</dt>
            <dd className="text-ink">{client.coRegState ?? "—"}</dd>
          </div>
          <div>
            <dt className="mb-0.5 text-xs text-ink-muted">Renewal Month</dt>
            <dd className="text-ink">{client.renewMonth ?? "—"}</dd>
          </div>
          {client.note && (
            <div className="sm:col-span-2">
              <dt className="mb-0.5 text-xs text-ink-muted">Note</dt>
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
                <td className="py-2">
                  <span
                    className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                      a.active ? "bg-[var(--status-done-soft)] text-[var(--status-done)]" : "bg-black/5 text-ink-muted"
                    }`}
                  >
                    {a.active ? "Active" : "Inactive"}
                  </span>
                </td>
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

        {isAdmin && !client.archivedAt && (
          <AssignProjectPanel clientId={client.id} projects={assignable} />
        )}
      </div>

      <div className="mt-6 rounded-lg border border-line bg-surface p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-muted">
            Files
            {documents.length > 0 && (
              <span className="count-pill ml-2 bg-black/5 align-middle normal-case tracking-normal">
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
