import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { TagManager } from "@/components/tag-manager";

// Admin → Tags. Tags are created on the fly from a client page or the bulk
// bar on the clients list; this is where they're tidied up. Renaming or
// recolouring a tag changes it on every client, which is why it's admin-only.
export default async function TagsPage() {
  const tags = await prisma.tag.findMany({
    include: { _count: { select: { clients: true } } },
    orderBy: { name: "asc" },
  });

  return (
    <div className="mx-auto w-full max-w-3xl px-8 py-8">
      <Link href="/" className="text-sm text-ink-muted hover:text-accent">
        ← Back to home
      </Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">Client Tags</h1>
      <p className="mt-1 text-sm text-ink-muted">
        Labels on clients, used as a filter on the dashboard, tasks and clients pages. Add them from a
        client&apos;s page or in bulk from the clients list; rename, recolour or remove them here.
      </p>
      <div className="mt-6">
        <TagManager
          tags={tags.map((t) => ({ id: t.id, name: t.name, color: t.color, clients: t._count.clients }))}
        />
      </div>
    </div>
  );
}
