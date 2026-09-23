"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { requireAdminAction, requireClientAccess } from "@/lib/access";
import { recordAudit, recordAuditMany, actorFrom, AUDIT } from "@/lib/audit";
import { normalizeTagName, sameTagName, defaultTagColor, isTagColor } from "@/lib/tags";
import {
  isSavedViewPath,
  sanitizeViewQuery,
  normalizeViewName,
  MAX_VIEWS_PER_PERSON,
} from "@/lib/saved-views";

// Ways of organizing work: client tags, client groups and saved views. Kept
// out of the already-large actions.ts, the same way time and comment actions
// are. Access rules are the ones in src/lib/permissions.ts: tagging a client
// or changing its group is editing the client (needs to work with it);
// renaming, recolouring or deleting a tag changes it for every client, so that
// is admin-only.

function revalidateOrganize(clientIds: string[] = []) {
  revalidatePath("/");
  revalidatePath("/tasks");
  revalidatePath("/clients");
  revalidatePath("/admin/tags");
  for (const id of clientIds) revalidatePath(`/clients/${id}`);
}

// --- Tags ----------------------------------------------------------------------

async function findOrCreateTag(rawName: string) {
  const name = normalizeTagName(rawName);
  // Case-insensitive match against what exists: "vip" should attach the
  // existing "VIP" tag, not create a second one. SQLite's unique index is
  // case-sensitive, so this is checked here. The list is small.
  const existing = await prisma.tag.findMany({ select: { id: true, name: true, color: true } });
  const match = existing.find((t) => sameTagName(t.name, name));
  if (match) return match;
  return prisma.tag.create({ data: { name, color: defaultTagColor(name) } });
}

async function clientLabel(clientId: string) {
  const c = await prisma.client.findUnique({ where: { id: clientId }, select: { companyName: true } });
  return c?.companyName ?? "Client";
}

export async function addClientTag(clientId: string, tagName: string) {
  const user = await requireClientAccess(clientId);
  const tag = await findOrCreateTag(tagName);
  const already = await prisma.clientTag.findUnique({
    where: { clientId_tagId: { clientId, tagId: tag.id } },
  });
  if (already) return tag;
  await prisma.clientTag.create({ data: { clientId, tagId: tag.id } });
  const label = await clientLabel(clientId);
  await recordAudit({
    entityType: "Client",
    entityId: clientId,
    action: AUDIT.CLIENT_TAGS_CHANGED,
    summary: `Tagged ${label} “${tag.name}”`,
    toValue: tag.name,
    clientId,
    contextLabel: label,
    actor: actorFrom(user),
  });
  revalidateOrganize([clientId]);
  return tag;
}

export async function removeClientTag(clientId: string, tagId: string) {
  const user = await requireClientAccess(clientId);
  const link = await prisma.clientTag.findUnique({
    where: { clientId_tagId: { clientId, tagId } },
    include: { tag: true },
  });
  if (!link) return;
  await prisma.clientTag.delete({ where: { clientId_tagId: { clientId, tagId } } });
  const label = await clientLabel(clientId);
  await recordAudit({
    entityType: "Client",
    entityId: clientId,
    action: AUDIT.CLIENT_TAGS_CHANGED,
    summary: `Removed tag “${link.tag.name}” from ${label}`,
    fromValue: link.tag.name,
    clientId,
    contextLabel: label,
    actor: actorFrom(user),
  });
  revalidateOrganize([clientId]);
}

export async function updateTag(tagId: string, data: { name?: string; color?: string }) {
  await requireAdminAction();
  const tag = await prisma.tag.findUnique({ where: { id: tagId } });
  if (!tag) throw new Error("That tag no longer exists.");
  const next: { name?: string; color?: string } = {};
  if (data.name !== undefined) {
    const name = normalizeTagName(data.name);
    const clash = (await prisma.tag.findMany({ select: { id: true, name: true } })).find(
      (t) => t.id !== tagId && sameTagName(t.name, name)
    );
    if (clash) throw new Error(`There's already a tag called “${clash.name}”.`);
    next.name = name;
  }
  if (data.color !== undefined) {
    if (!isTagColor(data.color)) throw new Error("Pick one of the listed colours.");
    next.color = data.color;
  }
  await prisma.tag.update({ where: { id: tagId }, data: next });
  revalidateOrganize();
}

export async function deleteTag(tagId: string) {
  await requireAdminAction();
  // ClientTag rows cascade; the clients themselves are untouched.
  await prisma.tag.delete({ where: { id: tagId } }).catch(() => {
    throw new Error("That tag no longer exists.");
  });
  revalidateOrganize();
}

// --- Bulk client organizing (clients list) ------------------------------------------

export type BulkClientResult = { changed: number; skipped: number };

// Applies a tag or a group to many clients at once. Clients the caller can't
// edit are skipped and counted rather than failing the whole batch, so the
// result says exactly what happened.
export async function bulkOrganizeClients(
  clientIds: string[],
  op: { kind: "add-tag"; tagName: string } | { kind: "set-group"; groupName: string | null }
): Promise<BulkClientResult> {
  const user = await requireUser();
  const ids = [...new Set(clientIds)].slice(0, 500);
  if (ids.length === 0) return { changed: 0, skipped: 0 };

  const allowed: string[] = [];
  for (const id of ids) {
    try {
      await requireClientAccess(id);
      allowed.push(id);
    } catch {
      // counted as skipped below
    }
  }

  let changed = 0;
  if (op.kind === "add-tag") {
    const tag = await findOrCreateTag(op.tagName);
    const have = new Set(
      (
        await prisma.clientTag.findMany({
          where: { tagId: tag.id, clientId: { in: allowed } },
          select: { clientId: true },
        })
      ).map((r) => r.clientId)
    );
    const toAdd = allowed.filter((id) => !have.has(id));
    if (toAdd.length > 0) {
      await prisma.clientTag.createMany({ data: toAdd.map((clientId) => ({ clientId, tagId: tag.id })) });
    }
    changed = toAdd.length;
    const names = new Map(
      (
        await prisma.client.findMany({ where: { id: { in: toAdd } }, select: { id: true, companyName: true } })
      ).map((c) => [c.id, c.companyName])
    );
    await recordAuditMany(
      toAdd.map((clientId) => ({
        entityType: "Client",
        entityId: clientId,
        action: AUDIT.CLIENT_TAGS_CHANGED,
        summary: `Tagged ${names.get(clientId) ?? "client"} “${tag.name}” (bulk)`,
        toValue: tag.name,
        clientId,
        contextLabel: names.get(clientId) ?? null,
        actor: actorFrom(user),
      }))
    );
  } else {
    const groupName = op.groupName?.replace(/\s+/g, " ").trim() || null;
    if (groupName && groupName.length > 80) throw new Error("Keep group names under 80 characters.");
    // Read first so each changed client gets its own history row with the
    // old value; after updateMany there would be no way to know it. `not: X`
    // excludes NULLs in SQL, hence the explicit OR for clients with no group.
    const targets = await prisma.client.findMany({
      where: {
        id: { in: allowed },
        ...(groupName
          ? { OR: [{ groupName: null }, { groupName: { not: groupName } }] }
          : { groupName: { not: null } }),
      },
      select: { id: true, companyName: true, groupName: true },
    });
    if (targets.length > 0) {
      await prisma.client.updateMany({
        where: { id: { in: targets.map((t) => t.id) } },
        data: { groupName },
      });
    }
    changed = targets.length;
    await recordAuditMany(
      targets.map((t) => ({
        entityType: "Client",
        entityId: t.id,
        action: AUDIT.CLIENT_UPDATED,
        summary: groupName
          ? `Moved ${t.companyName} into group “${groupName}” (bulk)`
          : `Removed ${t.companyName} from group “${t.groupName}” (bulk)`,
        fromValue: t.groupName,
        toValue: groupName,
        clientId: t.id,
        contextLabel: t.companyName,
        actor: actorFrom(user),
      }))
    );
  }

  revalidateOrganize(allowed);
  return { changed, skipped: ids.length - allowed.length };
}

// --- Saved views -----------------------------------------------------------------

export async function createSavedView(input: {
  name: string;
  path: string;
  query: string;
  shared?: boolean;
}) {
  const user = await requireUser();
  if (!isSavedViewPath(input.path)) throw new Error("Views can't be saved on this page.");
  const name = normalizeViewName(input.name);
  const query = sanitizeViewQuery(input.path, input.query);
  // Sharing puts a view in front of the whole team; admins curate that list.
  const shared = input.shared === true && user.role === "ADMIN";

  const count = await prisma.savedView.count({ where: { ownerId: user.id } });
  if (count >= MAX_VIEWS_PER_PERSON) {
    throw new Error(`You have ${count} saved views — delete one before adding another.`);
  }

  const view = await prisma.savedView.create({
    data: { ownerId: user.id, name, path: input.path, query, shared },
  });
  revalidatePath(input.path);
  return { id: view.id, name: view.name, query: view.query, shared: view.shared };
}

export async function deleteSavedView(viewId: string) {
  const user = await requireUser();
  const view = await prisma.savedView.findUnique({ where: { id: viewId } });
  if (!view) return;
  // Your own views are yours to delete; a shared one can also be removed by
  // an admin (it's on everyone's list), but never somebody else's private one.
  const mayDelete = view.ownerId === user.id || (view.shared && user.role === "ADMIN");
  if (!mayDelete) throw new Error("You can only delete your own views.");
  await prisma.savedView.delete({ where: { id: viewId } });
  revalidatePath(view.path);
}
