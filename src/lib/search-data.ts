import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/auth";
import { messageScope } from "@/lib/email-data";
import { excerpt, type SearchGroupKey } from "@/lib/search";

// Global search: one query across clients, contacts, services, tasks,
// comments, notes, files and email. Not a "use server" module — these are
// reads for the /search page.
//
// Every group is scoped exactly like the page its results link to. An
// employee's results come only from engagements they're assigned to (the same
// rule as the assignment page), and a client only appears if they work with
// it, so search can't become a side door around the visibility rules.

export type SearchHit = {
  id: string;
  title: string;
  // Where it lives — "Acme Ltd · Bookkeeping · 2026-08".
  context: string | null;
  // The matching text, excerpted around the match.
  snippet: string | null;
  href: string;
  badge?: string;
};

export type SearchResults = Record<SearchGroupKey, { hits: SearchHit[]; total: number }>;

// Case-insensitive `contains`. SQLite's LIKE already ignores ASCII case;
// Postgres needs `mode: "insensitive"`, which SQLite's client rejects — so
// it's only added when the database actually is Postgres.
const IS_POSTGRES = /^postgres(ql)?:/.test(process.env.DATABASE_URL ?? "");
function like(q: string) {
  return (IS_POSTGRES ? { contains: q, mode: "insensitive" } : { contains: q }) as { contains: string };
}

function assignmentHref(clientId: string, projectId: string, extra: Record<string, string | null> = {}) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(extra)) if (v) p.set(k, v);
  const q = p.toString();
  return `/assignments/${clientId}/${projectId}${q ? `?${q}` : ""}`;
}

export async function globalSearch(
  user: CurrentUser,
  q: string,
  options: { limit: number }
): Promise<SearchResults> {
  const isAdmin = user.role === "ADMIN";
  const take = options.limit;

  // The engagements an employee may see. Admins: no restriction.
  const mine = isAdmin
    ? null
    : await prisma.clientActivity.findMany({
        where: { assigneeId: user.id },
        select: { clientId: true, projectId: true },
        distinct: ["clientId", "projectId"],
      });
  const engagementScope = mine
    ? { OR: mine.length ? mine.map((m) => ({ clientId: m.clientId, projectId: m.projectId })) : [{ id: "__none__" }] }
    : {};
  const clientIds = mine ? [...new Set(mine.map((m) => m.clientId))] : null;
  const clientScope = clientIds ? { id: { in: clientIds } } : {};
  // Archived clients: hidden from employees, labelled for admins (who may be
  // looking for one to restore).
  const clientVisibility = isAdmin ? {} : { archivedAt: null };
  const viaClient = isAdmin ? {} : { client: { archivedAt: null } };

  const clientWhere = {
    ...clientScope,
    ...clientVisibility,
    OR: [
      { companyName: like(q) },
      { groupName: like(q) },
      { email: like(q) },
      { phone: like(q) },
      { taxId: like(q) },
      { city: like(q) },
      { note: like(q) },
      { tags: { some: { tag: { name: like(q) } } } },
    ],
  };
  const contactWhere = {
    client: { ...clientScope, ...clientVisibility },
    OR: [
      { firstName: like(q) },
      { lastName: like(q) },
      { email: like(q) },
      { mobile: like(q) },
      { note: like(q) },
    ],
  };
  const projectWhere = {
    ...(mine ? { id: { in: [...new Set(mine.map((m) => m.projectId))] } } : {}),
    OR: [{ name: like(q) }, { description: like(q) }],
  };
  // Tasks: a step's name, or the free-text notes field on it. Current and
  // past periods both — "when did we last do the 1099s for Acme" is a search.
  const taskWhere = {
    ...engagementScope,
    ...viaClient,
    OR: [{ subTask: { name: like(q) } }, { notes: like(q) }],
  };
  const commentWhere = { body: like(q), activity: { ...engagementScope, ...viaClient } };
  const noteWhere = { body: like(q), ...engagementScope, ...viaClient };
  const fileWhere = { filename: like(q), ...engagementScope, ...viaClient };
  const emailWhere = {
    AND: [
      messageScope(user),
      {
        OR: [
          { subject: like(q) },
          { bodyText: like(q) },
          { toEmail: like(q) },
          { fromEmail: like(q) },
          { toName: like(q) },
          { fromName: like(q) },
        ],
      },
    ],
  };

  const [
    clients,
    clientTotal,
    contacts,
    contactTotal,
    projects,
    projectTotal,
    tasks,
    taskTotal,
    comments,
    commentTotal,
    notes,
    noteTotal,
    files,
    fileTotal,
    emails,
    emailTotal,
  ] = await Promise.all([
    prisma.client.findMany({ where: clientWhere, take, orderBy: { companyName: "asc" }, include: { tags: { include: { tag: true } } } }),
    prisma.client.count({ where: clientWhere }),
    prisma.corpContact.findMany({ where: contactWhere, take, include: { client: true }, orderBy: { lastName: "asc" } }),
    prisma.corpContact.count({ where: contactWhere }),
    prisma.project.findMany({ where: projectWhere, take, orderBy: { name: "asc" }, include: { recurring: true } }),
    prisma.project.count({ where: projectWhere }),
    prisma.clientActivity.findMany({
      where: taskWhere,
      take,
      include: { client: true, project: true, subTask: true, assignee: true },
      orderBy: [{ periodName: "desc" }, { taskSeqNo: "asc" }],
    }),
    prisma.clientActivity.count({ where: taskWhere }),
    prisma.taskComment.findMany({
      where: commentWhere,
      take,
      include: { activity: { include: { client: true, project: true, subTask: true } } },
      orderBy: { createdAt: "desc" },
    }),
    prisma.taskComment.count({ where: commentWhere }),
    prisma.assignmentNote.findMany({
      where: noteWhere,
      take,
      include: { client: true, project: true, author: true },
      orderBy: { createdAt: "desc" },
    }),
    prisma.assignmentNote.count({ where: noteWhere }),
    prisma.document.findMany({
      where: fileWhere,
      take,
      include: { client: true, project: true },
      orderBy: { createdAt: "desc" },
    }),
    prisma.document.count({ where: fileWhere }),
    prisma.emailMessage.findMany({ where: emailWhere, take, include: { client: true }, orderBy: { createdAt: "desc" } }),
    prisma.emailMessage.count({ where: emailWhere }),
  ]);

  const firstMatch = (q: string, ...fields: (string | null | undefined)[]) =>
    fields.find((f) => f && f.toLowerCase().includes(q.toLowerCase())) ?? null;

  return {
    clients: {
      total: clientTotal,
      hits: clients.map((c) => {
        const matchedTag = c.tags.find((t) => t.tag.name.toLowerCase().includes(q.toLowerCase()));
        const field = firstMatch(q, c.groupName, c.email, c.phone, c.taxId, c.city, c.note);
        return {
          id: c.id,
          title: c.companyName,
          context: [c.groupName, c.city].filter(Boolean).join(" · ") || null,
          snippet: c.companyName.toLowerCase().includes(q.toLowerCase())
            ? null
            : matchedTag
            ? `Tag: ${matchedTag.tag.name}`
            : field
            ? excerpt(field, q)
            : null,
          href: `/clients/${c.id}`,
          badge: c.archivedAt ? "Archived" : undefined,
        };
      }),
    },
    contacts: {
      total: contactTotal,
      hits: contacts.map((c) => ({
        id: c.id,
        title: [c.firstName, c.lastName].filter(Boolean).join(" ") || c.email || c.mobile || "Contact",
        context: c.client.companyName,
        snippet: [c.email, c.mobile].filter(Boolean).join(" · ") || (c.note ? excerpt(c.note, q) : null),
        href: `/clients/${c.clientId}`,
      })),
    },
    projects: {
      total: projectTotal,
      hits: projects.map((p) => ({
        id: p.id,
        title: p.name,
        context: p.recurring.type.charAt(0) + p.recurring.type.slice(1).toLowerCase().replace("_", " "),
        snippet: p.description ? excerpt(p.description, q) : null,
        href: `/projects/${p.id}`,
      })),
    },
    tasks: {
      total: taskTotal,
      hits: tasks.map((a) => ({
        id: a.id,
        title: a.subTask.name,
        context: `${a.client.companyName} · ${a.project.name} · ${a.periodName}`,
        snippet: a.notes && a.notes.toLowerCase().includes(q.toLowerCase()) ? excerpt(a.notes, q) : null,
        href: assignmentHref(a.clientId, a.projectId, { period: a.periodName }),
        badge: a.status === "DONE" ? "Done" : a.assignee ? `${a.assignee.firstName} ${a.assignee.lastName}` : "Unassigned",
      })),
    },
    comments: {
      total: commentTotal,
      hits: comments.map((c) => ({
        id: c.id,
        title: `${c.authorLabel} on ${c.activity.subTask.name}`,
        context: `${c.activity.client.companyName} · ${c.activity.project.name} · ${c.activity.periodName}`,
        snippet: excerpt(c.body, q),
        href: assignmentHref(c.activity.clientId, c.activity.projectId, { period: c.activity.periodName }),
        badge: c.createdAt.toLocaleDateString(),
      })),
    },
    notes: {
      total: noteTotal,
      hits: notes.map((n) => ({
        id: n.id,
        title: n.author ? `Note by ${n.author.firstName} ${n.author.lastName}` : "Note",
        context: `${n.client.companyName} · ${n.project.name}`,
        snippet: excerpt(n.body, q),
        href: assignmentHref(n.clientId, n.projectId, { tab: "notes" }),
        badge: n.createdAt.toLocaleDateString(),
      })),
    },
    files: {
      total: fileTotal,
      hits: files.map((d) => ({
        id: d.id,
        title: d.filename,
        context: `${d.client.companyName} · ${d.project.name}${d.periodName ? ` · ${d.periodName}` : ""}`,
        snippet: null,
        href: assignmentHref(d.clientId, d.projectId, { tab: "files", period: d.periodName }),
        badge: d.createdAt.toLocaleDateString(),
      })),
    },
    emails: {
      total: emailTotal,
      hits: emails.map((m) => ({
        id: m.id,
        title: m.subject || "(no subject)",
        context: `${m.direction === "INBOUND" ? `From ${m.fromName || m.fromEmail}` : `To ${m.toName || m.toEmail}`}${
          m.client ? ` · ${m.client.companyName}` : ""
        }`,
        snippet: m.bodyText.toLowerCase().includes(q.toLowerCase()) ? excerpt(m.bodyText, q) : null,
        href: `/email/${m.id}`,
        badge: m.createdAt.toLocaleDateString(),
      })),
    },
  };
}
