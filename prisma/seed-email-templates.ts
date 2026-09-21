import { PrismaClient } from "@prisma/client";
import { BUILT_IN_TEMPLATES } from "./email-templates";

// Loads the built-in email templates into a database that already exists,
// without touching anything else (prisma/seed.ts wipes and rebuilds, which is
// not what you want on a database with real work in it).
//
// Idempotent, and deliberately non-destructive: a template whose key is
// already present is left alone, so edits someone made to the wording survive
// re-running this.
//
//   ./node_modules/.bin/tsx prisma/seed-email-templates.ts

const prisma = new PrismaClient();

async function main() {
  let created = 0;
  let skipped = 0;

  for (const template of BUILT_IN_TEMPLATES) {
    const existing = await prisma.emailTemplate.findUnique({
      where: { key: template.key },
    });
    if (existing) {
      skipped += 1;
      continue;
    }
    await prisma.emailTemplate.create({ data: { ...template, builtIn: true } });
    console.log(`  + ${template.name}`);
    created += 1;
  }

  console.log(`${created} template(s) added, ${skipped} already present.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
