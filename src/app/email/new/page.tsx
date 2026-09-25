import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { EmailComposer } from "@/components/email-composer";
import { composerClients, composerTemplates } from "@/lib/email-data";
import { transportIsLive } from "@/lib/email";

// Compose. Accepts ?clientId / ?projectId / ?period so the page can be deep
// linked from anywhere that already knows the engagement — the client page,
// an assignment, a report — without that caller needing to know anything about
// how mail is composed.
export default async function ComposeEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ clientId?: string; projectId?: string; period?: string }>;
}) {
  const user = await requireUser();
  const { clientId, projectId, period } = await searchParams;

  const [clients, templates] = await Promise.all([
    composerClients(user),
    composerTemplates(),
  ]);

  // Only honour a prefilled client the user is actually allowed to write to.
  const allowed = clientId && clients.some((c) => c.id === clientId) ? clientId : undefined;
  const allowedProject =
    allowed && projectId && clients.find((c) => c.id === allowed)?.projects.some((p) => p.id === projectId)
      ? projectId
      : null;

  return (
    <div className="mx-auto w-full max-w-3xl px-8 py-8">
      <Link href="/email" className="text-sm text-ink-muted hover:text-accent">
        ← All email
      </Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">New message</h1>
      <p className="mt-1 text-sm text-ink-muted">
        Attach the message to a client and project and it joins that
        engagement&apos;s thread, so replies come back to the same place.
      </p>

      <div className="mt-6 rounded-lg border border-line bg-surface p-6">
        {clients.length === 0 ? (
          <p className="py-6 text-center text-sm text-ink-muted">
            You don&apos;t have any clients to write to yet.
          </p>
        ) : (
          <EmailComposer
            clients={clients}
            templates={templates}
            live={transportIsLive()}
            fixedClientId={allowed}
            fixedProjectId={allowedProject}
            fixedPeriodName={period ?? null}
          />
        )}
      </div>
    </div>
  );
}
