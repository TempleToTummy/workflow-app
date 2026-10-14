// Gets the database ready before the server starts on a host like Render:
//
//   1. Brings the schema up to date (`prisma db push`).
//   2. Seeds a brand-new, empty database so there's an admin to sign in with.
//      A database with anyone in it is never seeded — the seed wipes data.
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
// the push retried. On Postgres that never happens automatically — the push
// stops and says why, so a person decides.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

process.env.DATABASE_URL ||= "file:./dev.db";
const url = process.env.DATABASE_URL;
const isSqlite = url.startsWith("file:");

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

async function main() {
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

  // 2. Seed a brand-new database only
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
