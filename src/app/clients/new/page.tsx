import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { ClientForm } from "@/components/client-form";
import { requireUser } from "@/lib/auth";

export default async function NewClientPage() {
  await requireUser();
  const [corpTypes, businessTypes, projects] = await Promise.all([
    prisma.corporationType.findMany({ orderBy: { name: "asc" } }),
    prisma.businessType.findMany({ orderBy: { name: "asc" } }),
    prisma.project.findMany({
      include: { recurring: true, subtasks: true },
      orderBy: { name: "asc" },
    }),
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
      />
    </div>
  );
}
