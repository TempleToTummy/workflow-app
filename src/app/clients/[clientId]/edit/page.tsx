import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { ClientForm } from "@/components/client-form";
import { requireUser } from "@/lib/auth";
import { canAccessClient } from "@/lib/access";
import { clientGroupNames } from "@/lib/client-groups";

export default async function EditClientPage({
  params,
}: {
  params: Promise<{ clientId: string }>;
}) {
  const user = await requireUser();
  const { clientId } = await params;
  // The same gate as the client's detail page. This page used to have none, so
  // any signed-in employee could open any client's details by URL.
  if (!(await canAccessClient(user, clientId))) redirect("/clients");

  const [client, corpTypes, businessTypes, projects, groups] = await Promise.all([
    prisma.client.findUnique({
      where: { id: clientId },
      include: {
        projectAssignments: { where: { active: true } },
        contacts: { orderBy: { createdAt: "asc" } },
      },
    }),
    prisma.corporationType.findMany({ orderBy: { name: "asc" } }),
    prisma.businessType.findMany({ orderBy: { name: "asc" } }),
    prisma.project.findMany({
      include: { recurring: true, subtasks: true },
      orderBy: { name: "asc" },
    }),
    clientGroupNames(user),
  ]);

  if (!client) notFound();

  const services = projects.map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    recurring: p.recurring.type,
    stepCount: p.subtasks.length,
  }));
  const assignedServiceIds = client.projectAssignments.map((a) => a.projectId);

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-10">
      <Link
        href={`/clients/${client.id}`}
        className="text-sm text-ink-muted hover:text-accent"
      >
        ← Back to {client.companyName}
      </Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">Edit Client</h1>

      <ClientForm
        mode="edit"
        client={{
          ...client,
          coRegDate: client.coRegDate ? client.coRegDate.toISOString() : undefined,
          groupName: client.groupName ?? undefined,
          corpTypeId: client.corpTypeId ?? undefined,
          businessTypeId: client.businessTypeId ?? undefined,
          address1: client.address1 ?? undefined,
          address2: client.address2 ?? undefined,
          city: client.city ?? undefined,
          state: client.state ?? undefined,
          zipcode: client.zipcode ?? undefined,
          phone: client.phone ?? undefined,
          fax: client.fax ?? undefined,
          taxId: client.taxId ?? undefined,
          email: client.email ?? undefined,
          note: client.note ?? undefined,
          coRegState: client.coRegState ?? undefined,
          renewMonth: client.renewMonth ?? undefined,
        }}
        contacts={client.contacts}
        corpTypes={corpTypes}
        businessTypes={businessTypes}
        services={services}
        assignedServiceIds={assignedServiceIds}
        canManageServices={user.role === "ADMIN"}
        groupSuggestions={groups}
      />
    </div>
  );
}
