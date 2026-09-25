import Link from "next/link";
import { PAGE_SIZE } from "@/lib/work-rules";

// Previous/next paging for the long lists (dashboard, tasks, admin client
// activity, the activity list report). Server component: every page is a
// plain link that keeps the current filters and only changes ?page, so a page
// is bookmarkable and the back button works. FilterBar drops ?page whenever a
// filter changes, so a narrower filter never lands past its own last page.
export { PAGE_SIZE, pageFromParams } from "@/lib/work-rules";

export function Pager({
  path,
  params,
  page,
  total,
  pageSize = PAGE_SIZE,
  noun,
}: {
  path: string;
  params: Record<string, string | undefined>;
  page: number;
  total: number;
  pageSize?: number;
  noun: [string, string];
}) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  if (pageCount <= 1) return null;

  const href = (n: number) => {
    const p = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (key !== "page" && value) p.set(key, value);
    }
    if (n > 1) p.set("page", String(n));
    const q = p.toString();
    return q ? `${path}?${q}` : path;
  };
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);

  return (
    <nav aria-label="Pages" className="no-print mt-4 flex items-center justify-between text-sm">
      {page > 1 ? (
        <Link href={href(page - 1)} className="text-accent hover:underline">
          ← Previous
        </Link>
      ) : (
        <span />
      )}
      <span className="tabular text-ink-muted">
        {first.toLocaleString()}–{last.toLocaleString()} of {total.toLocaleString()}{" "}
        {total === 1 ? noun[0] : noun[1]} · page {page} of {pageCount}
      </span>
      {page < pageCount ? (
        <Link href={href(page + 1)} className="text-accent hover:underline">
          Next →
        </Link>
      ) : (
        <span />
      )}
    </nav>
  );
}
