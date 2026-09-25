import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { EmployeeForm } from "@/components/employee-form";

export default async function NewEmployeePage() {
  const employeeTypes = await prisma.employeeType.findMany({ orderBy: { name: "asc" } });

  return (
    <div className="mx-auto w-full max-w-3xl px-8 py-8">
      <Link href="/admin/employees" className="text-sm text-ink-muted hover:text-accent">
        ← Back to employees
      </Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">New Employee</h1>

      <EmployeeForm mode="create" employeeTypes={employeeTypes} />
    </div>
  );
}
