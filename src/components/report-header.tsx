import { ExportBar } from "@/components/export-bar";

// The heading block every report shares, with the export controls docked to
// the right and a print-only stamp underneath.
//
// A SERVER component on purpose, even though it renders the client-side
// ExportBar. It prints `new Date()`, and doing that inside a client component
// renders one time on the server and a different one during hydration — a
// guaranteed hydration mismatch. Rendering it on the server means the
// timestamp is simply the moment the page was produced, which is also the
// honest meaning of "Printed …".
//
// The stamp matters more than it looks: a printed report with no date on it is
// indistinguishable from last quarter's a week later, and these are documents
// people put in front of clients.
export function ReportHeader({
  title,
  description,
  reportKey,
  query,
  children,
}: {
  title: string;
  description?: string;
  reportKey: string;
  query?: Record<string, string | null | undefined>;
  children?: React.ReactNode;
}) {
  return (
    <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-ink-muted">{description}</p>}
        <p className="print-only mt-1 text-xs text-ink-muted">
          Printed{" "}
          {new Intl.DateTimeFormat("en-US", {
            dateStyle: "long",
            timeStyle: "short",
          }).format(new Date())}
        </p>
        {children}
      </div>
      <ExportBar reportKey={reportKey} query={query} />
    </div>
  );
}
