import { getCurrentUser } from "@/lib/auth";
import { toCsv, exportFilename, csvHeaders } from "@/lib/csv";
import { REPORT_EXPORTS, isExportKey } from "@/lib/report-export";

// CSV download for any report. One route rather than one per report: the only
// thing that varies is which builder runs, and twelve near-identical route
// files would be twelve places for the auth check to drift.
//
// Auth is checked here and not left to src/proxy.ts. The proxy only knows
// whether a cookie exists; this needs a valid session AND, for a firm-wide
// report, the ADMIN role — the same rule src/app/reports/layout.tsx applies to
// the pages. Without that, an employee scoped to their own clients could pull
// the whole firm's data through /api/export even though the page refuses them.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ report: string }> }
) {
  const user = await getCurrentUser();
  if (!user) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { report } = await params;
  if (!isExportKey(report)) {
    return new Response("Unknown report", { status: 404 });
  }

  const definition = REPORT_EXPORTS[report];
  if (definition.scope === "admin" && user.role !== "ADMIN") {
    // 403, not 404: the caller is authenticated and the report exists, so
    // pretending otherwise would just make a real permission problem look
    // like a broken link to whoever reports it.
    return new Response("Forbidden", { status: 403 });
  }

  const url = new URL(request.url);

  let table;
  try {
    table = await definition.build({
      employeeId: user.id,
      isAdmin: user.role === "ADMIN",
      params: url.searchParams,
    });
  } catch (err) {
    // A failed export returns plain text, not an HTML error page: the browser
    // is expecting a file download, and an HTML body would land on disk as a
    // .csv full of markup.
    console.error(`[export] ${report} failed`, err);
    return new Response("That export couldn't be produced. Please try again.", {
      status: 500,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  const body = toCsv(table.headers, table.rows);
  return new Response(body, { headers: csvHeaders(exportFilename(definition.label)) });
}
