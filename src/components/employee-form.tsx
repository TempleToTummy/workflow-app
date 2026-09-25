"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  createEmployee,
  updateEmployee,
  createEmployeeType,
  type EmployeeFormInput,
} from "@/lib/actions";

type Lookup = { id: string; name: string };
type ExistingEmployee = EmployeeFormInput & { id: string };

const inputClass =
  "rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40";

export function EmployeeForm({
  mode,
  employee,
  employeeTypes,
}: {
  mode: "create" | "edit";
  employee?: ExistingEmployee;
  employeeTypes: Lookup[];
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [types, setTypes] = useState(employeeTypes);
  const [newType, setNewType] = useState("");

  function handleAddType() {
    if (!newType.trim()) return;
    startTransition(async () => {
      try {
        const created = await createEmployeeType(newType);
        if (created) setTypes((prev) => [...prev, created]);
        setNewType("");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't add type.");
      }
    });
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const form = new FormData(e.currentTarget);
    const values: EmployeeFormInput = {
      firstName: String(form.get("firstName") ?? ""),
      lastName: String(form.get("lastName") ?? ""),
      email: String(form.get("email") ?? ""),
      role: String(form.get("role") ?? "EMPLOYEE") === "ADMIN" ? "ADMIN" : "EMPLOYEE",
      phone: String(form.get("phone") ?? ""),
      mobile: String(form.get("mobile") ?? ""),
      country: String(form.get("country") ?? ""),
      employeeTypeId: String(form.get("employeeTypeId") ?? ""),
    };

    startTransition(async () => {
      try {
        if (mode === "create") {
          await createEmployee(values);
        } else {
          await updateEmployee(employee!.id, values);
        }
        router.push("/admin/employees");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't save employee.");
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-6">
      <div className="rounded-lg border border-line bg-surface p-6">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-ink-muted">First Name *</span>
            <input
              name="firstName"
              defaultValue={employee?.firstName}
              required
              className={inputClass}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-ink-muted">Last Name *</span>
            <input
              name="lastName"
              defaultValue={employee?.lastName}
              required
              className={inputClass}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-ink-muted">Email *</span>
            <input
              name="email"
              type="email"
              defaultValue={employee?.email ?? ""}
              required
              className={inputClass}
            />
            <span className="text-[11px] text-ink-muted">Used to sign in.</span>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-ink-muted">Role *</span>
            <select
              name="role"
              defaultValue={employee?.role ?? "EMPLOYEE"}
              className={inputClass}
            >
              <option value="EMPLOYEE">Employee</option>
              <option value="ADMIN">Admin</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-ink-muted">Phone</span>
            <input name="phone" defaultValue={employee?.phone ?? ""} className={inputClass} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-ink-muted">Mobile</span>
            <input name="mobile" defaultValue={employee?.mobile ?? ""} className={inputClass} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-ink-muted">Country</span>
            <input name="country" defaultValue={employee?.country ?? ""} className={inputClass} />
          </label>
          <label className="flex flex-col gap-1 text-sm sm:col-span-2">
            <span className="text-xs text-ink-muted">Employee Type</span>
            <select
              name="employeeTypeId"
              defaultValue={employee?.employeeTypeId ?? ""}
              className={inputClass}
            >
              <option value="">— none —</option>
              {types.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            <span className="mt-2 flex gap-2">
              <input
                value={newType}
                onChange={(e) => setNewType(e.target.value)}
                placeholder="Add a new type"
                className={`flex-1 ${inputClass}`}
              />
              <button
                type="button"
                onClick={handleAddType}
                disabled={isPending || !newType.trim()}
                className="rounded-md border border-line px-3 py-2 text-sm text-ink hover:bg-black/5 disabled:opacity-50"
              >
                Add
              </button>
            </span>
          </label>
        </div>
      </div>

      {error && <p className="text-sm text-overdue">{error}</p>}

      <div className="flex gap-3">
        <button
          type="submit"
          disabled={isPending}
          className="whitespace-nowrap rounded-full bg-accent px-5 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {isPending ? "Saving…" : mode === "create" ? "Create Employee" : "Save Changes"}
        </button>
        <button
          type="button"
          onClick={() => router.back()}
          className="rounded-full border border-line px-5 py-2 text-sm font-medium text-ink hover:bg-black/5"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
