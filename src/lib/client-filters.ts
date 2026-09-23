// The Group and Tag filters, shared by the dashboard, tasks and clients pages.
// Pure (no next/*, no Prisma) so it can be imported by client and server code
// alike and tested in scripts/test-organize.ts.

// "(No group)" in the Group menu. A sentinel rather than an empty string,
// because an empty value already means "no filter".
export const NO_GROUP = "__none__";

export type ClientFilterable = { groupName: string | null; tagIds: string[] };
export type ClientFilterParams = { group?: string | null; tag?: string | null };

export function matchesClientFilters(client: ClientFilterable, params: ClientFilterParams): boolean {
  const group = params.group?.trim();
  if (group) {
    const has = client.groupName?.trim() || null;
    if (group === NO_GROUP ? has !== null : has !== group) return false;
  }
  const tag = params.tag?.trim();
  if (tag && !client.tagIds.includes(tag)) return false;
  return true;
}
