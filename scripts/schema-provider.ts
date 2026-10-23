// Points prisma/schema.prisma at a different database engine, in place.
//
//   npx tsx scripts/schema-provider.ts mysql        (or sqlite | postgresql)
//   npx tsx scripts/schema-provider.ts mysql --check   → print the result, change nothing
//
// The schema in git stays on SQLite so local development needs no setup. The
// production Docker image runs this before `prisma generate` (Dockerfile,
// DB_PROVIDER build arg), so the client it ships is built for the engine it
// will actually talk to. Prisma can't choose the provider at runtime.
//
// MySQL needs more than the provider line. Prisma maps `String` to
// VARCHAR(191) there, which would silently cap notes, email bodies, user
// agents and every encrypted value. So on MySQL each String field becomes
// TEXT, except the ones TEXT can't serve:
//   - @id / @unique fields, and fields in an @@id / @@unique / @@index
//     (MySQL can't index a TEXT column without a prefix length),
//   - foreign keys (they must match the VARCHAR id they point at),
//   - fields with a literal @default("…") (short, enum-like values; MySQL
//     only allows expression defaults on TEXT).
// Those stay VARCHAR(191), which is ample for ids, emails, hashes and names.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const PROVIDERS = ["sqlite", "mysql", "postgresql"] as const;
type Provider = (typeof PROVIDERS)[number];

export function schemaForProvider(schema: string, provider: Provider): string {
  let out = schema.replace(
    /(datasource\s+db\s*\{[^}]*?provider\s*=\s*)"[^"]*"([^\n]*)/,
    (_m, head: string) => `${head}"${provider}"`
  );
  // Native-type attributes from an earlier run are engine-specific; start clean.
  out = out.replace(/ @db\.Text\b/g, "");
  if (provider === "mysql") out = widenStrings(out);
  return out;
}

function widenStrings(schema: string): string {
  return schema.replace(/^model\s+\w+\s*\{[\s\S]*?^\}/gm, (block) => {
    const keep = new Set<string>();
    // Fields named in block attributes: @@id, @@unique, @@index.
    for (const m of block.matchAll(/@@(?:id|unique|index)\(\s*\[([^\]]*)\]/g)) {
      for (const name of m[1].split(",")) keep.add(name.trim().split(/[\s(]/)[0]);
    }
    // Foreign keys: @relation(fields: [a, b], …).
    for (const m of block.matchAll(/@relation\([^)]*fields:\s*\[([^\]]*)\]/g)) {
      for (const name of m[1].split(",")) keep.add(name.trim());
    }
    return block.replace(
      /^(\s+)(\w+)(\s+)String(\??)([^\n]*)$/gm,
      (line, indent: string, name: string, gap: string, opt: string, rest: string) => {
        const attrs = rest.replace(/\/\/.*$/, "");
        if (keep.has(name) || /@id\b|@unique\b|@default\(\s*"/.test(attrs)) return line;
        const comment = rest.match(/\s*\/\/.*$/)?.[0] ?? "";
        const body = rest.slice(0, rest.length - comment.length).replace(/\s+$/, "");
        return `${indent}${name}${gap}String${opt}${body} @db.Text${comment}`;
      }
    );
  });
}

function main() {
  const [provider, flag] = process.argv.slice(2);
  if (!PROVIDERS.includes(provider as Provider)) {
    console.error(`Usage: tsx scripts/schema-provider.ts <${PROVIDERS.join("|")}> [--check]`);
    process.exit(1);
  }
  const file = path.join(process.cwd(), "prisma", "schema.prisma");
  const next = schemaForProvider(readFileSync(file, "utf8"), provider as Provider);
  if (flag === "--check") {
    process.stdout.write(next);
    return;
  }
  writeFileSync(file, next);
  console.log(`prisma/schema.prisma now targets ${provider}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) main();
