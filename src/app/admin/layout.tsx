import type { ReactNode } from "react";
import { requireAdmin } from "@/lib/auth";

// One gate for every /admin/* route. Non-admins are redirected to the dashboard.
export default async function AdminLayout({ children }: { children: ReactNode }) {
  await requireAdmin();
  return children;
}
