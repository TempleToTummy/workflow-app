import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { EmployeeForm } from "@/components/employee-form";
import { EmployeeProjects } from "@/components/employee-projects";
import { RECURRING_SHORT_LABELS } from "@/lib/period-names";

export default async function EditEmployeePage({
  params,
}: {
  params: Promise<{ employeeId: string }>;
}) {
  const { employeeId } = await params;

  const [employee, employeeTypes, projects] = await Promise.all([
    prisma.employee.findUnique({ where: { id: employeeId } }),
    prisma.employeeType.findMany({ orderBy: { name: "asc" } }),
    prisma.project.findMany({
      orderBy: { name: "asc" },
      include: {
        recurring: true,
        owner: { select: { firstName: true, lastName: true } },
        _count: { select: { clientAssignments: { where: { active: true, client: { archivedAt: null } } } } },
      },
    }),
  ]);

  if (!employee) notFound();

  return (
    <div className="mx-auto w-full max-w-3xl px-8 py-8">
      <Link href="/admin/employees" className="text-sm text-ink-muted hover:text-accent">
        ← Back to employees
      </Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">Edit Employee</h1>

      <EmployeeForm
        mode="edit"
        employee={{
          id: employee.id,
          firstName: employee.firstName,
          lastName: employee.lastName,
          email: employee.email,
          role: employee.role,
          phone: employee.phone ?? undefined,
          mobile: employee.mobile ?? undefined,
          country: employee.country ?? undefined,
          employeeTypeId: employee.employeeTypeId ?? undefined,
        }}
        employeeTypes={employeeTypes}
      />

      <EmployeeProjects
        employeeId={employee.id}
        employeeName={`${employee.firstName} ${employee.lastName}`}
        owned={projects.filter((p) => p.ownerId === employee.id).map((p) => p.id)}
        projects={projects.map((p) => ({
          id: p.id,
          name: p.name,
          recurringLabel: RECURRING_SHORT_LABELS[p.recurring.type],
          otherOwner:
            p.owner && p.ownerId !== employee.id ? `${p.owner.firstName} ${p.owner.lastName}` : null,
          activeClients: p._count.clientAssignments,
        }))}
      />
    </div>
  );
}
