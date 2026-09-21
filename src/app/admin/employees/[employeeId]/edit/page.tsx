import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { EmployeeForm } from "@/components/employee-form";

export default async function EditEmployeePage({
  params,
}: {
  params: Promise<{ employeeId: string }>;
}) {
  const { employeeId } = await params;

  const [employee, employeeTypes] = await Promise.all([
    prisma.employee.findUnique({ where: { id: employeeId } }),
    prisma.employeeType.findMany({ orderBy: { name: "asc" } }),
  ]);

  if (!employee) notFound();

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-10">
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
    </div>
  );
}
