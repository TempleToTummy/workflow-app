// Gets the database ready before the server starts on a host like Render:
//
//   1. Brings the schema up to date (`prisma db push`).
//   2. First run. In production (NODE_ENV=production, as the Docker image sets)
//      that's prisma/setup.ts: the firm's service catalog and email templates,
//      and an invite link for FIRST_ADMIN_EMAIL — no demo data, no default
//      password. It's idempotent and runs on every start. Elsewhere, a
//      brand-new empty database gets the demo seed (prisma/seed.ts); a
//      database with anyone in it is never seeded — the seed wipes data.
//   3. Runs the data upgrades (`scripts/upgrade-data.ts --apply`).
//   4. Encrypts anything stored before encryption existed
//      (`scripts/encrypt-at-rest.ts --apply`), when the keys are set.
//
// Every step is idempotent, so it runs on every start: `npm run start:deploy`.
// It runs at start, not build, because a host's build machine can't see the
// database disk.
//
// SQLite only: if the schema change needs Prisma's --accept-data-loss (a new
// unique key, a changed primary key), the database file is copied first and
// the push retried. On MySQL or Postgres that never happens automatically —
// the push stops and says why, so a person decides.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

process.env.DATABASE_URL ||= "file:./dev.db";
const url = process.env.DATABASE_URL;
const isSqlite = url.startsWith("file:");

// The Prisma client is generated for one engine (scripts/schema-provider.ts,
// the Dockerfile's DB_PROVIDER). A URL for a different one fails deep inside
// Prisma with an unhelpful message, so say it plainly up front.
const URL_SCHEMES: Record<string, RegExp> = {
  sqlite: /^file:/,
  mysql: /^mysql:/,
  postgresql: /^postgres(ql)?:/,
};
const schemaProvider =
  readFileSync(path.join(process.cwd(), "prisma", "schema.prisma"), "utf8").match(
    /datasource\s+db\s*\{[^}]*?provider\s*=\s*"([^"]+)"/
  )?.[1] ?? "unknown";
if (!URL_SCHEMES[schemaProvider]?.test(url)) {
  console.error(
    `[deploy] This build is for ${schemaProvider}, but DATABASE_URL is for a different database ` +
      `("${url.split(":")[0]}:…"). Fix DATABASE_URL, or rebuild with DB_PROVIDER set to match it.`
  );
  process.exit(1);
}

function run(cmd: string, args: string[]): number {
  console.log(`\n$ ${cmd} ${args.join(" ")}`);
  const result = spawnSync(cmd, args, { stdio: "inherit", env: process.env });
  return result.status ?? 1;
}

function sqliteFile(): string {
  // Relative SQLite paths are relative to prisma/schema.prisma's folder.
  const file = url.slice("file:".length).split("?")[0];
  return path.isAbsolute(file) ? file : path.join(process.cwd(), "prisma", file);
}

// A failed `db push` looks the same whether the database is unreachable or the
// change needs approval, so connect first and say which it is.
async function checkConnection() {
  const prisma = new PrismaClient();
  try {
    await prisma.$queryRawUnsafe("SELECT 1");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\n[deploy] Can't connect to the database:\n${message.trim()}\n`);
    if (/insecure transport|secure_transport|SSL|TLS/i.test(message)) {
      console.error(
        "[deploy] The server requires an encrypted connection. Add ?sslaccept=accept_invalid_certs " +
          "to the end of DATABASE_URL."
      );
    } else if (/Access denied|Authentication failed/i.test(message)) {
      console.error("[deploy] Check the user name and password in DATABASE_URL.");
    } else {
      console.error("[deploy] Check the host, port and database name in DATABASE_URL, and that this server can reach it.");
    }
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

async function main() {
  if (!isSqlite) await checkConnection();

  // 1. Schema
  if (run("npx", ["prisma", "db", "push", "--skip-generate"]) !== 0) {
    if (!isSqlite) {
      console.error(
        "\n[deploy] The schema change needs a person to approve it on this database. " +
          "Back it up, then run `npx prisma db push` by hand and read what it says."
      );
      process.exit(1);
    }
    const file = sqliteFile();
    if (existsSync(file)) {
      const copy = `${file}.before-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      copyFileSync(file, copy);
      console.log(`[deploy] Copied the database to ${copy} before applying the schema change.`);
    }
    if (run("npx", ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"]) !== 0) process.exit(1);
  }

  // 2. First run
  if (process.env.NODE_ENV === "production") {
    if (run("npx", ["tsx", "prisma/setup.ts"]) !== 0) process.exit(1);
  } else {
    await seedEmptyDevDatabase();
  }

  // 3. Data upgrades
  if (run("npx", ["tsx", "scripts/upgrade-data.ts", "--apply"]) !== 0) process.exit(1);

  // 4. Encryption at rest
  if (process.env.DATA_ENCRYPTION_KEYS && process.env.DATA_INDEX_KEY) {
    if (run("npx", ["tsx", "scripts/encrypt-at-rest.ts", "--apply"]) !== 0) process.exit(1);
  } else {
    console.warn(
      "\n[deploy] DATA_ENCRYPTION_KEYS / DATA_INDEX_KEY aren't set. The app will run, but it " +
        "refuses to store uploaded files, tax IDs or SSNs until they are. See .env.example."
    );
  }
}

async function seedEmptyDevDatabase() {
  const prisma = new PrismaClient();
  const people = await prisma.employee.count();
  await prisma.$disconnect();
  if (people === 0) {
    if (run("npx", ["tsx", "prisma/seed.ts"]) !== 0) process.exit(1);
    console.warn(
      "\n[deploy] Seeded an empty database. Sign in as admin@workflow.test / admin1234 " +
        "and change that password straight away."
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
