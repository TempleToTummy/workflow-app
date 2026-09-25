import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { globalSearch } from "@/lib/search-data";
import {
  normalizeQuery,
  highlight,
  isSearchGroup,
  SEARCH_GROUPS,
  MIN_QUERY_LENGTH,
  type SearchGroupKey,
} from "@/lib/search";
import { SearchBox } from "@/components/search-box";

const PER_GROUP = 5;
const PER_GROUP_FOCUSED = 50;

function Marked({ text, query }: { text: string; query: string }) {
  return (
    <>
      {highlight(text, query).map((part, i) =>
        part.match ? (
          <mark key={i} className="rounded-sm bg-[var(--status-review-soft)] px-0.5 text-ink">
            {part.text}
          </mark>
        ) : (
          <span key={i}>{part.text}</span>
        )
      )}
    </>
  );
}

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; type?: string }>;
}) {
  const user = await requireUser();
  const params = await searchParams;
  const q = normalizeQuery(params.q);
  const focus: SearchGroupKey | null = isSearchGroup(params.type) ? params.type : null;

  const results = q ? await globalSearch(user, q, { limit: focus ? PER_GROUP_FOCUSED : PER_GROUP }) : null;
  const total = results ? Object.values(results).reduce((n, g) => n + g.total, 0) : 0;
  const groups = SEARCH_GROUPS.filter((g) => (focus ? g.key === focus : true)).filter(
    (g) => results && results[g.key].total > 0
  );

  const href = (type: string | null) => {
    const p = new URLSearchParams();
    if (q) p.set("q", q);
    if (type) p.set("type", type);
    return `/search?${p.toString()}`;
  };

  return (
    <div className="mx-auto w-full max-w-6xl px-8 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Search</h1>
      <p className="mt-1 text-sm text-ink-muted">
        Clients, contacts, services, tasks, comments, notes, files and email
        {user.role === "ADMIN" ? " across the firm" : " on the work you're assigned to"}.
      </p>

      <div className="mt-4">
        <SearchBox key={params.q ?? ""} initial={params.q ?? ""} autoFocus={!q} />
      </div>

      {!q && (params.q ?? "").trim().length > 0 && (
        <p className="mt-6 text-sm text-ink-muted">Type at least {MIN_QUERY_LENGTH} characters.</p>
      )}

      {results && (
        <>
          <div className="mt-6 flex flex-wrap gap-2 text-sm">
            <Link
              href={href(null)}
              className={`rounded-full border px-3 py-1 ${
                !focus ? "border-accent/40 bg-accent-soft text-accent" : "border-line text-ink-muted hover:text-ink"
              }`}
            >
              All <span className="tabular">{total}</span>
            </Link>
            {SEARCH_GROUPS.filter((g) => results[g.key].total > 0).map((g) => (
              <Link
                key={g.key}
                href={href(g.key)}
                className={`rounded-full border px-3 py-1 ${
                  focus === g.key
                    ? "border-accent/40 bg-accent-soft text-accent"
                    : "border-line text-ink-muted hover:text-ink"
                }`}
              >
                {g.label} <span className="tabular">{results[g.key].total}</span>
              </Link>
            ))}
          </div>

          {total === 0 && (
            <div className="mt-8 rounded-lg border border-dashed border-line px-4 py-10 text-center text-sm text-ink-muted">
              Nothing matches “{q}”. Try a shorter word, part of a name, or an email address.
            </div>
          )}

          <div className="mt-6 flex flex-col gap-6">
            {groups.map((g) => {
              const group = results[g.key];
              return (
                <section key={g.key} aria-labelledby={`search-${g.key}`}>
                  <div className="mb-2 flex items-baseline justify-between">
                    <h2 id={`search-${g.key}`} className="text-sm font-semibold uppercase tracking-wide text-ink-muted">
                      {g.label}
                    </h2>
                    {group.total > group.hits.length && (
                      <Link href={href(g.key)} className="text-sm text-accent hover:underline">
                        {focus ? `Showing ${group.hits.length} of ${group.total}` : `Show all ${group.total}`}
                      </Link>
                    )}
                  </div>
                  <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
                    {group.hits.map((hit) => (
                      <li key={hit.id}>
                        <Link href={hit.href} className="block px-4 py-3 hover:bg-black/[0.02]">
                          <div className="flex items-center justify-between gap-3">
                            <span className="truncate text-sm font-medium text-ink">
                              <Marked text={hit.title} query={q!} />
                            </span>
                            {hit.badge && (
                              <span className="shrink-0 rounded-full bg-black/5 px-2 py-0.5 text-[11px] text-ink-muted">
                                {hit.badge}
                              </span>
                            )}
                          </div>
                          {hit.context && (
                            <p className="mt-0.5 truncate text-xs text-ink-muted">
                              <Marked text={hit.context} query={q!} />
                            </p>
                          )}
                          {hit.snippet && (
                            <p className="mt-1 text-sm text-ink-muted">
                              <Marked text={hit.snippet} query={q!} />
                            </p>
                          )}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
