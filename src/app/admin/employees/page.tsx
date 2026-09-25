import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { DeleteButton } from "@/components/delete-button";
import { RoleSelect, AccountCell } from "@/components/employee-account-cell";
import { EmployeeBillingCell } from "@/components/employee-billing-cell";
import { deleteEmployee } from "@/lib/actions";
import { EmployeeSecurityCell } from "@/components/employee-security-cell";
import { requireAdmin } from "@/lib/auth";

export default async function EmployeesPage() {
  const admin = await requireAdmin();
  const [employees, sessionCounts] = await Promise.all([
    prisma.employee.findMany({
      include: { employeeType: true },
      orderBy: { firstName: "asc" },
    }),
    prisma.session.groupBy({
      by: ["employeeId"],
      where: { expiresAt: { gt: new Date() } },
      _count: { _all: true },
    }),
  ]);
  const sessionsBy = new Map(sessionCounts.map((s) => [s.employeeId, s._count._all]));

  return (
    <div className="mx-auto w-full max-w-6xl px-8 py-8">
      <Link href="/" className="text-sm text-ink-muted hover:text-accent">
        ← Back to home
      </Link>
      <div className="mt-2 flex items-start justify-between gap-6">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">Employees</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Create an employee, then send them the invite link to set a password.
            Rate and weekly capacity feed the Time Summary report and the Workload view.
          </p>
        </div>
        <Link
          href="/admin/employees/new"
          className="shrink-0 whitespace-nowrap rounded-full bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90"
        >
          New Employee
        </Link>
      </div>

      <div className="mt-6 overflow-x-auto rounded-lg border border-line bg-surface">
        <table className="w-full min-w-[980px] text-left text-sm">
          <thead>
            <tr className="border-b border-line bg-black/[0.02] text-xs uppercase tracking-wide text-ink-muted">
              <th className="px-4 py-3 font-medium">Name</th>
              <th className="px-4 py-3 font-medium">Email</th>
              <th className="px-4 py-3 font-medium">Role</th>
              <th className="px-4 py-3 font-medium">Rate &amp; capacity</th>
              <th className="px-4 py-3 font-medium">Account</th>
              <th className="px-4 py-3 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {employees.map((e) => (
              <tr key={e.id} className="border-b border-line align-middle last:border-0 hover:bg-black/[0.015]">
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
                  <EmployeeBillingCell
                    employeeId={e.id}
                    hourlyRate={e.hourlyRate}
                    weeklyCapacityMinutes={e.weeklyCapacityMinutes}
                  />
                </td>
                <td className="px-4 py-3">
                  <AccountCell
                    employeeId={e.id}
                    hasPassword={e.passwordHash !== null}
                    inviteToken={e.inviteToken}
                  />
                  {e.passwordHash !== null && (
                    <EmployeeSecurityCell
                      employeeId={e.id}
                      name={`${e.firstName} ${e.lastName}`}
                      twoFactor={e.totpEnabledAt !== null}
                      sessions={sessionsBy.get(e.id) ?? 0}
                      isSelf={e.id === admin.id}
                    />
                  )}
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
                <td colSpan={6} className="px-4 py-10 text-center text-ink-muted">
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
