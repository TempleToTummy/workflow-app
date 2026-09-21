"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { Role } from "@prisma/client";
import { REPORTS, ADMIN_GROUPS } from "@/lib/nav-data";
import { logout } from "@/lib/auth-actions";

function NavLink({ href, label, exact = false }: { href: string; label: string; exact?: boolean }) {
  const pathname = usePathname();
  const active = exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
  return (
    <Link
      href={href}
      className={`flex items-center rounded-md px-3 py-2 text-sm transition-colors ${
        active
          ? "bg-sidebar-active-bg font-medium text-sidebar-active-ink"
          : "text-sidebar-ink hover:bg-sidebar-hover"
      }`}
    >
      {label}
    </Link>
  );
}

function NavGroup({
  label,
  active,
  children,
}: {
  label: string;
  active: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(active);
  return (
    <div>
      <button
        onClick={() => setOpen((o) => !o)}
        className={`flex w-full items-center justify-between rounded-md px-3 py-2 text-sm transition-colors ${
          active && !open ? "text-sidebar-active-ink" : "text-sidebar-ink hover:bg-sidebar-hover"
        }`}
      >
        <span className={active ? "font-medium" : ""}>{label}</span>
        <svg
          viewBox="0 0 20 20"
          fill="none"
          className={`h-3.5 w-3.5 shrink-0 text-sidebar-ink-muted transition-transform ${open ? "rotate-90" : ""}`}
        >
          <path d="M7 5l6 5-6 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && <div className="mt-0.5 ml-2 flex flex-col gap-0.5 border-l border-sidebar-border pl-3">{children}</div>}
    </div>
  );
}

function SignOutButton() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  return (
    <button
      onClick={() =>
        startTransition(async () => {
          await logout();
          router.replace("/login");
        })
      }
      disabled={isPending}
      className="rounded-md px-3 py-1.5 text-left text-xs text-sidebar-ink-muted transition-colors hover:bg-sidebar-hover hover:text-sidebar-ink disabled:opacity-50"
    >
      {isPending ? "Signing out…" : "Sign out"}
    </button>
  );
}

export function SidebarNav({
  user,
}: {
  user: { firstName: string; lastName: string; role: Role };
}) {
  const pathname = usePathname();
  const reportsActive = pathname.startsWith("/reports");
  const adminActive = pathname.startsWith("/admin");
  const isAdmin = user.role === "ADMIN";

  return (
    <aside className="flex h-screen w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar-bg">
      <div className="flex items-center gap-2.5 px-5 py-5">
        <div className="flex h-8 w-8 items-center justify-center rounded-md bg-sidebar-active-ink text-sm font-semibold text-sidebar-bg">
          W
        </div>
        <span className="text-sm font-semibold tracking-tight text-sidebar-ink">Workflow</span>
      </div>

      <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-3 pb-4">
        <NavLink href="/" label="Dashboard" exact />
        <NavLink href="/clients" label="Clients" />
        <NavLink href="/projects" label="Projects" />
        <NavLink href="/tasks" label="Tasks" />
        <NavLink href="/email" label="Email" />

        {isAdmin && (
          <>
            <div className="mt-4 mb-1 px-3 text-[11px] font-medium tracking-wide text-sidebar-ink-muted uppercase">
              Insights
            </div>
            <NavLink href="/activity" label="Activity log" />
            <NavGroup label="Reports" active={reportsActive}>
              {REPORTS.map((r) => (
                <Link
                  key={r.href}
                  href={r.href}
                  className={`rounded-md px-2.5 py-1.5 text-sm transition-colors ${
                    pathname === r.href
                      ? "font-medium text-sidebar-active-ink"
                      : "text-sidebar-ink-muted hover:bg-sidebar-hover hover:text-sidebar-ink"
                  }`}
                >
                  {r.label}
                </Link>
              ))}
            </NavGroup>

            <div className="mt-4 mb-1 px-3 text-[11px] font-medium tracking-wide text-sidebar-ink-muted uppercase">
              Configuration
            </div>
            <NavGroup label="Admin Menu" active={adminActive}>
              {ADMIN_GROUPS.map((group) => (
                <div key={group.heading} className="mb-2 last:mb-0">
                  <p className="px-2.5 pt-1 pb-0.5 text-[10px] font-medium tracking-wide text-sidebar-ink-muted/70 uppercase">
                    {group.heading}
                  </p>
                  {group.items.map((item) => (
                    <Link
                      key={item.href}
                      href={item.href}
                      className={`block rounded-md px-2.5 py-1.5 text-sm transition-colors ${
                        pathname === item.href
                          ? "font-medium text-sidebar-active-ink"
                          : "text-sidebar-ink-muted hover:bg-sidebar-hover hover:text-sidebar-ink"
                      }`}
                    >
                      {item.label}
                    </Link>
                  ))}
                </div>
              ))}
            </NavGroup>
          </>
        )}
      </nav>

      <div className="flex flex-col gap-1 border-t border-sidebar-border px-3 py-3">
        <div className="px-3">
          <p className="truncate text-sm text-sidebar-ink">
            {user.firstName} {user.lastName}
          </p>
          <p className="text-[11px] uppercase tracking-wide text-sidebar-ink-muted">
            {isAdmin ? "Admin" : "Employee"}
          </p>
        </div>
        <SignOutButton />
      </div>
    </aside>
  );
}
