import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { LookupManager } from "@/components/lookup-manager";
import {
  createCorporationType,
  deleteCorporationType,
  createBusinessType,
  deleteBusinessType,
} from "@/lib/actions";

export default async function BusinessTypesPage() {
  const [corpTypes, businessTypes] = await Promise.all([
    prisma.corporationType.findMany({ orderBy: { name: "asc" } }),
    prisma.businessType.findMany({ orderBy: { name: "asc" } }),
  ]);

  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-10">
      <Link href="/" className="text-sm text-ink-muted hover:text-accent">
        ← Back to home
      </Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">
        Corporate &amp; Business Type
      </h1>
      <p className="mt-1 text-sm text-ink-muted">
        The lookup lists used on the client form&apos;s Corporation Type and Business Type fields.
      </p>

      <div className="mt-6 grid grid-cols-1 gap-6 sm:grid-cols-2">
        <LookupManager
          title="Corporation Type"
          items={corpTypes}
          onCreate={createCorporationType}
          onDelete={deleteCorporationType}
        />
        <LookupManager
          title="Business Type"
          items={businessTypes}
          onCreate={createBusinessType}
          onDelete={deleteBusinessType}
        />
      </div>
    </div>
  );
}
