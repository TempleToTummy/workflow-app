import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { EmailTemplateManager } from "@/components/email-template-manager";
import { TEMPLATE_VARIABLES } from "@/lib/email";

// The firm's reusable messages. Anyone can read them (they're what the compose
// screen offers); only admins can change them, which the server actions
// enforce independently of this page.
export default async function EmailTemplatesPage() {
  const user = await requireUser();

  const templates = await prisma.emailTemplate.findMany({
    orderBy: [{ builtIn: "desc" }, { name: "asc" }],
  });

  // How often each template has actually been used, so a template nobody
  // reaches for is visible as dead weight.
  const usage = await prisma.emailMessage.groupBy({
    by: ["templateKey"],
    _count: { _all: true },
    where: { templateKey: { not: null } },
  });
  const usageByKey = new Map(usage.map((u) => [u.templateKey!, u._count._all]));

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-10">
      <Link href="/email" className="text-sm text-ink-muted hover:text-accent">
        ← All email
      </Link>
      <h1 className="mt-3 text-2xl font-semibold tracking-tight">Email templates</h1>
      <p className="mt-1 text-sm text-ink-muted">
        Reusable messages for the things the firm writes over and over.
        Placeholders are filled in from the engagement being written about, so
        the same template says the right thing for every client.
      </p>

      <details className="mt-4 rounded-lg border border-line bg-surface px-4 py-3">
        <summary className="cursor-pointer text-sm font-medium text-ink">
          Available placeholders
        </summary>
        <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2">
          {TEMPLATE_VARIABLES.map((v) => (
            <div key={v.key} className="flex flex-col">
              <dt className="font-mono text-[11px] text-accent">{`{{${v.key}}}`}</dt>
              <dd className="text-xs text-ink-muted">{v.description}</dd>
            </div>
          ))}
        </dl>
      </details>

      <div className="mt-6">
        <EmailTemplateManager
          canEdit={user.role === "ADMIN"}
          templates={templates.map((t) => ({
            id: t.id,
            key: t.key,
            name: t.name,
            description: t.description,
            subject: t.subject,
            body: t.body,
            builtIn: t.builtIn,
            usageCount: usageByKey.get(t.key) ?? 0,
          }))}
        />
      </div>
    </div>
  );
}
