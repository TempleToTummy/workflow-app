import type { ReactNode } from "react";
import { requireAdmin } from "@/lib/auth";

// Reports are firm-wide views, so they're admin-only: employees see only the
// work assigned to them, and every report would leak the rest.
export default async function ReportsLayout({ children }: { children: ReactNode }) {
  await requireAdmin();
  return children;
}
