import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { DeleteButton } from "@/components/delete-button";
import { RoleSelect, AccountCell } from "@/components/employee-account-cell";
import { deleteEmployee } from "@/lib/actions";

export default async function EmployeesPage() {
  const employees = await prisma.employee.findMany({
    include: { employeeType: true },
    orderBy: { firstName: "asc" },
  });

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-10">
      <Link href="/" className="text-sm text-ink-muted hover:text-accent">
        ← Back to home
      </Link>
      <div className="mt-2 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Employees</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Create an employee, then send them the invite link to set a password.
          </p>
        </div>
        <Link
          href="/admin/employees/new"
          className="rounded-full bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90"
        >
          New Employee
        </Link>
      </div>

      <div className="mt-6 overflow-x-auto rounded-lg border border-line bg-surface">
        <table className="w-full min-w-[820px] text-left text-sm">
          <thead>
            <tr className="border-b border-line bg-black/[0.02] text-xs uppercase tracking-wide text-ink-muted">
              <th className="px-4 py-3 font-medium">Name</th>
              <th className="px-4 py-3 font-medium">Email</th>
              <th className="px-4 py-3 font-medium">Role</th>
              <th className="px-4 py-3 font-medium">Account</th>
              <th className="px-4 py-3 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {employees.map((e) => (
              <tr key={e.id} className="border-b border-line last:border-0 align-top">
                <td className="px-4 py-3">
                  <p className="font-medium text-ink">
                    {e.firstName} {e.lastName}
                  </p>
                  {e.employeeType?.name && (
                    <p className="text-xs text-ink-muted">{e.employeeType.name}</p>
                  )}
                </td>
                <td className="px-4 py-3 text-ink-muted">{e.email}</td>
                <td className="px-4 py-3">
                  <RoleSelect employeeId={e.id} role={e.role} />
                </td>
                <td className="px-4 py-3">
                  <AccountCell
                    employeeId={e.id}
                    hasPassword={e.passwordHash !== null}
                    inviteToken={e.inviteToken}
                  />
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center justify-end gap-3">
                    <Link
                      href={`/admin/employees/${e.id}/edit`}
                      className="text-xs text-accent hover:underline"
                    >
                      Edit
                    </Link>
                    <DeleteButton
                      onDelete={deleteEmployee.bind(null, e.id)}
                      confirmMessage={`Delete ${e.firstName} ${e.lastName}?`}
                    />
                  </div>
                </td>
              </tr>
            ))}
            {employees.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center text-ink-muted">
                  No employees yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
