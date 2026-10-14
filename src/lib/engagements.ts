// Engagements: one client running one project. A client can run the same
// project several times at once, independently — "Bookkeeping" and
// "Bookkeeping 2" — so an engagement is identified by (clientId, projectId,
// instance), not just the first two. Instance 1 is the original; every
// engagement that existed before copies were possible is instance 1, which is
// why old links and old data keep working unchanged.
//
// Pure — no Prisma, no next/* — so scripts/test-engagements.ts covers it.

export type EngagementKey = { clientId: string; projectId: string; instance: number };

// Prisma's name for the ProjectClientMap primary key.
export function engagementId(key: EngagementKey) {
  return {
    clientId_projectId_instance: {
      clientId: key.clientId,
      projectId: key.projectId,
      instance: key.instance,
    },
  };
}

// A `where` that selects one engagement's rows in any engagement-scoped table.
export function engagementWhere(key: EngagementKey) {
  return { clientId: key.clientId, projectId: key.projectId, instance: key.instance };
}

// A string key for grouping rows in memory. Never contains ":" ambiguity:
// ids are cuids and instance is a number.
export function engagementKeyString(key: { clientId: string; projectId: string; instance?: number | null }): string {
  return `${key.clientId}:${key.projectId}:${key.instance ?? 1}`;
}

export function parseInstance(raw: string | string[] | null | undefined): number {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 999 ? n : 1;
}

// What an engagement is called on screen: its own name if it has one, else
// the project's name, numbered for copies after the first.
export function engagementLabel(projectName: string, name: string | null | undefined, instance: number = 1): string {
  const own = name?.trim();
  if (own) return own;
  return instance > 1 ? `${projectName} ${instance}` : projectName;
}

// The next free instance number for another copy of a project.
export function nextInstance(existing: number[]): number {
  return existing.length === 0 ? 1 : Math.max(...existing) + 1;
}

// Link to an engagement's page. Instance 1 keeps the original URL shape.
export function engagementHref(
  key: { clientId: string; projectId: string; instance?: number | null },
  options: { period?: string | null; tab?: string | null } = {}
): string {
  const q = new URLSearchParams();
  if ((key.instance ?? 1) > 1) q.set("n", String(key.instance));
  if (options.tab && options.tab !== "list") q.set("tab", options.tab);
  if (options.period) q.set("period", options.period);
  const qs = q.toString();
  return `/assignments/${key.clientId}/${key.projectId}${qs ? `?${qs}` : ""}`;
}

export const MAX_ENGAGEMENT_NAME = 120;

export function cleanEngagementName(raw: string | null | undefined): string | null {
  const text = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  if (text.length > MAX_ENGAGEMENT_NAME) {
    throw new Error(`Keep the name under ${MAX_ENGAGEMENT_NAME} characters.`);
  }
  return text;
}

// A single-string reference to one engagement's project, for pickers whose
// option value is one string (the email composer). Instance 1 is just the
// project id, so existing values keep working.
export function projectRef(projectId: string, instance: number = 1): string {
  return instance > 1 ? `${projectId}#${instance}` : projectId;
}

export function splitProjectRef(ref: string | null | undefined): { projectId: string | null; instance: number } {
  if (!ref) return { projectId: null, instance: 1 };
  const [projectId, n] = ref.split("#");
  return { projectId: projectId || null, instance: n ? parseInstance(n) : 1 };
}

// Who is responsible for an engagement — the project-level assignment that
// decides who sees it and who its periods are pre-assigned to: the client's
// own owner for this copy, else the project's owner ("Projects they handle").
export function responsibleId(e: {
  defaultAssigneeId: string | null;
  project: { ownerId: string | null };
}): string | null {
  return e.defaultAssigneeId ?? e.project.ownerId;
}
