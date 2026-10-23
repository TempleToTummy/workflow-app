// The schema rewrite the production image uses to target MySQL
// (scripts/schema-provider.ts). No database:
//
//   ./node_modules/.bin/tsx scripts/test-schema-provider.ts
import { readFileSync } from "node:fs";
import path from "node:path";
import { schemaForProvider } from "./schema-provider";
import { check, section, finish } from "./harness";

const SAMPLE = `datasource db {
  provider = "sqlite" // a comment
  url      = env("DATABASE_URL")
}

model Thing {
  id        String  @id @default(cuid())
  email     String  @unique // login
  ownerId   String
  owner     Owner   @relation(fields: [ownerId], references: [id])
  path      String
  color     String  @default("slate")
  note      String? // free text
  secret    String? @map("legacy")
  count     Int

  @@index([path, count])
}
`;

function field(schema: string, model: string, name: string): string {
  const block = schema.match(new RegExp(`model ${model} \\{[\\s\\S]*?\\n\\}`))?.[0] ?? "";
  return block.split("\n").find((l) => new RegExp(`^\\s+${name}\\s`).test(l))?.trim().replace(/\s+/g, " ") ?? "(missing)";
}

section("provider line");
const mysql = schemaForProvider(SAMPLE, "mysql");
check("switches to mysql", /provider = "mysql"\n/.test(mysql), true);
check("back to sqlite", /provider = "sqlite"\n/.test(schemaForProvider(mysql, "sqlite")), true);
check("postgresql", /provider = "postgresql"\n/.test(schemaForProvider(SAMPLE, "postgresql")), true);

section("MySQL: long text becomes TEXT");
check("plain optional string", field(mysql, "Thing", "note"), "note String? @db.Text // free text");
check("keeps @map", field(mysql, "Thing", "secret"), 'secret String? @map("legacy") @db.Text');

section("MySQL: what has to stay VARCHAR");
check("@id", field(mysql, "Thing", "id"), "id String @id @default(cuid())");
check("@unique (comment kept)", field(mysql, "Thing", "email"), "email String @unique // login");
check("foreign key", field(mysql, "Thing", "ownerId"), "ownerId String");
check("in an @@index", field(mysql, "Thing", "path"), "path String");
check('literal @default("…")', field(mysql, "Thing", "color"), 'color String @default("slate")');
check("non-strings untouched", field(mysql, "Thing", "count"), "count Int");

section("idempotent, and reversible");
check("running twice changes nothing", schemaForProvider(mysql, "mysql"), mysql);
check("sqlite drops the MySQL-only attributes", schemaForProvider(mysql, "sqlite"), SAMPLE.replace(' // a comment', ""));

section("the real schema");
const real = readFileSync(path.join(process.cwd(), "prisma", "schema.prisma"), "utf8");
const realMysql = schemaForProvider(real, "mysql");
check("git copy is SQLite (local dev needs no setup)", /provider\s*=\s*"sqlite"/.test(real), true);
check("a client's notes are TEXT", field(realMysql, "Client", "note").includes("@db.Text"), true);
check("an encrypted tax ID is TEXT", field(realMysql, "Client", "taxIdEncrypted").includes("@db.Text"), true);
check("the tax ID blind index stays indexable", field(realMysql, "Client", "taxIdIndex").includes("@db.Text"), false);
check("period name (part of a composite key) stays indexable", field(realMysql, "ClientActivity", "periodName").includes("@db.Text"), false);
check("a login email stays indexable", field(realMysql, "Employee", "email").includes("@db.Text"), false);

finish();
