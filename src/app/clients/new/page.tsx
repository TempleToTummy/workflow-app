import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { ClientForm } from "@/components/client-form";
import { requireAdmin } from "@/lib/auth";
import { clientGroupNames } from "@/lib/client-groups";

export default async function NewClientPage() {
  // Adding a client to the firm's book is an admin action (src/lib/permissions.ts).
  const user = await requireAdmin();
  const [corpTypes, businessTypes, projects, groups] = await Promise.all([
    prisma.corporationType.findMany({ orderBy: { name: "asc" } }),
    prisma.businessType.findMany({ orderBy: { name: "asc" } }),
    prisma.project.findMany({
      include: { recurring: true, subtasks: true },
      orderBy: { name: "asc" },
    }),
    clientGroupNames(user),
  ]);

  const services = projects.map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    recurring: p.recurring.type,
    stepCount: p.subtasks.length,
  }));

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-10">
      <Link href="/clients" className="text-sm text-ink-muted hover:text-accent">
        ← Back to clients
      </Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">New Client</h1>

      <ClientForm
        mode="create"
        corpTypes={corpTypes}
        businessTypes={businessTypes}
        services={services}
        groupSuggestions={groups}
      />
    </div>
  );
}
