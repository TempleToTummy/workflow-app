import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { requireUser, assigneeScope } from "@/lib/auth";
import { FilterBar } from "@/components/filter-bar";
import { ClientsTable } from "@/components/clients-table";
import { clientGroupNames, visibleTags } from "@/lib/client-options";
import { matchesClientFilters } from "@/lib/client-filters";

export default async function ClientsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | undefined }>;
}) {
  const user = await requireUser();
  const mine = assigneeScope(user);
  const isAdmin = user.role === "ADMIN";
  const params = await searchParams;
  // Archived clients are an admin concern (restoring, deleting); an employee's
  // list is the clients they're working with now.
  const showArchived = isAdmin && params.archived === "1";
  const groupBy = params.groupBy === "group";
  const query = (params.q ?? "").trim().toLowerCase();

  const [clients, archivedCount, activeCount, groups, tags] = await Promise.all([
    prisma.client.findMany({
      where: {
        archivedAt: showArchived ? { not: null } : null,
        // Employees see only clients they have a task on.
        ...(mine ? { activities: { some: { assigneeId: mine } } } : {}),
      },
      include: { businessType: true, tags: { include: { tag: true } } },
      orderBy: { companyName: "asc" },
    }),
    isAdmin ? prisma.client.count({ where: { archivedAt: { not: null } } }) : Promise.resolve(0),
    isAdmin ? prisma.client.count({ where: { archivedAt: null } }) : Promise.resolve(0),
    clientGroupNames(user),
    visibleTags(user),
  ]);

  const rows = clients
    .filter((c) =>
      matchesClientFilters(
        { groupName: c.groupName, tagIds: c.tags.map((t) => t.tagId) },
        { group: params.group, tag: params.tag }
      )
    )
    .filter(
      (c) =>
        !query ||
        [c.companyName, c.groupName, c.email, c.phone, c.taxId]
          .filter(Boolean)
          .some((v) => v!.toLowerCase().includes(query))
    )
    .map((c) => ({
      id: c.id,
      name: c.companyName,
      groupName: c.groupName,
      businessType: c.businessType?.name ?? null,
      phone: c.phone,
      email: c.email,
      tags: c.tags
        .map((t) => ({ id: t.tag.id, name: t.tag.name, color: t.tag.color }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    }));

  function href(patch: Record<string, string | null>): string {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) p.set(k, v);
    for (const [k, v] of Object.entries(patch)) {
      if (v) p.set(k, v);
      else p.delete(k);
    }
    const q = p.toString();
    return q ? `/clients?${q}` : "/clients";
  }

  const tabClass = (active: boolean) =>
    `flex items-center gap-1.5 rounded px-3 py-1.5 text-sm font-medium transition-colors ${
      active ? "bg-accent-soft text-accent" : "text-ink-muted hover:text-ink"
    }`;

  return (
    <div className="mx-auto w-full max-w-6xl px-8 py-8">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Client Project Information</h1>
          <p className="mt-1 text-sm text-ink-muted">
            {showArchived
              ? "Archived clients. They're hidden from every working view and get no new periods; open one to restore it."
              : mine
              ? "Clients you have work assigned on. Click one to see contacts and projects."
              : "Every client on file. Click one to see contacts and assigned projects."}
          </p>
        </div>
        {isAdmin && (
          <Link
            href="/clients/new"
            className="whitespace-nowrap rounded-full bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90"
          >
            New Client
          </Link>
        )}
      </div>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        {isAdmin ? (
          <div className="inline-flex rounded-md border border-line bg-surface p-0.5 shadow-sm">
            <Link href={href({ archived: null })} className={tabClass(!showArchived)}>
              Active
              <span className="count-pill bg-black/5">{activeCount}</span>
            </Link>
            <Link href={href({ archived: "1" })} className={tabClass(showArchived)}>
              Archived
              <span className="count-pill bg-black/5">{archivedCount}</span>
            </Link>
          </div>
        ) : (
          <span />
        )}
        <div className="inline-flex rounded-md border border-line bg-surface p-0.5 shadow-sm">
          <Link href={href({ groupBy: null })} className={tabClass(!groupBy)}>
            List
          </Link>
          <Link href={href({ groupBy: "group" })} className={tabClass(groupBy)}>
            By group
          </Link>
        </div>
      </div>

      <div className="mt-4 mb-4 rounded-lg border border-line bg-surface px-4 py-3">
        <FilterBar
          search
          searchPlaceholder="Search name, group, email, phone or tax ID"
          statuses={null}
          groups={groups.map((g) => ({ value: g, label: g }))}
          tags={tags.map((t) => ({ value: t.id, label: t.name }))}
          trailing={
            <span className="whitespace-nowrap text-sm text-ink-muted">
              {rows.length} {rows.length === 1 ? "client" : "clients"}
            </span>
          }
        />
      </div>

      <ClientsTable
        rows={rows}
        groupBy={groupBy}
        selectable={!showArchived}
        allTags={tags}
        groupSuggestions={groups}
      />
    </div>
  );
}
