// Encrypt everything that isn't, and move everything onto the active key.
//
//   npm run security:encrypt                 → dry run: report what would change
//   npm run security:encrypt -- --apply      → do it
//
// Run it:
//   * once after deploying encryption, to encrypt files, tax IDs and SSNs that
//     were stored before it existed (the app refuses to serve those until then);
//   * after restoring a pre-encryption (version 1) backup;
//   * after every key rotation: put the new key FIRST in DATA_ENCRYPTION_KEYS,
//     keep the old one after it, run this with --apply, and only then remove
//     the old key. Rotating a file only re-wraps its 32-byte data key; the file
//     itself isn't re-uploaded.
//
// Idempotent and resumable: each record is handled on its own, so an
// interrupted run is finished by running it again.
import { PrismaClient } from "@prisma/client";
import { objectStore } from "../src/lib/storage";
import {
  keyRing,
  encryptField,
  decryptField,
  fieldKeyId,
  isEncryptedField,
  rewrapFileKey,
  type FieldContext,
} from "../src/lib/encryption";
import { readDocumentBytes, storeDocumentBytes, isEncryptedDocument } from "../src/lib/document-vault";
import { checkSsn, checkTaxId, digitsOnly, protectSsn, protectTaxId } from "../src/lib/sensitive-fields";

const apply = process.argv.includes("--apply");
const ring = keyRing();

type Tally = Record<string, number>;
const tally: Tally = {};
const bump = (k: string) => (tally[k] = (tally[k] ?? 0) + 1);
const problems: string[] = [];

function looseLast4(raw: string): string | null {
  const d = digitsOnly(raw);
  return d.length >= 4 ? d.slice(-4) : null;
}

async function documents(prisma: PrismaClient) {
  const docs = await prisma.document.findMany({
    select: { id: true, clientId: true, bucket: true, storageKey: true, encKeyId: true, encWrappedKey: true, filename: true },
  });
  for (const doc of docs) {
    try {
      if (!isEncryptedDocument(doc)) {
        bump("files: plaintext → encrypted");
        if (!apply) continue;
        const bytes = await readDocumentBytes(doc, { allowLegacyPlaintext: true });
        const stored = await storeDocumentBytes({ documentId: doc.id, clientId: doc.clientId, bytes });
        await prisma.document.update({ where: { id: doc.id }, data: { ...stored, size: bytes.length } });
        if (stored.storageKey !== doc.storageKey || stored.bucket !== doc.bucket) {
          await objectStore.remove(doc.bucket, doc.storageKey).catch((err) => {
            problems.push(`file ${doc.id}: encrypted copy saved, but the old plaintext object couldn't be removed (${err})`);
          });
        }
      } else if (doc.encKeyId !== ring.activeId) {
        bump(`files: re-wrap ${doc.encKeyId} → ${ring.activeId}`);
        if (!apply) continue;
        const next = rewrapFileKey({ documentId: doc.id, keyId: doc.encKeyId!, wrappedKey: doc.encWrappedKey! });
        await prisma.document.update({ where: { id: doc.id }, data: { encKeyId: next.keyId, encWrappedKey: next.wrappedKey } });
      } else {
        bump("files: already current");
      }
    } catch (err) {
      problems.push(`file ${doc.id} ("${doc.filename}"): ${err instanceof Error ? err.message : err}`);
    }
  }
}

function needsWork(value: string, context: FieldContext): "legacy" | "rotate" | null {
  if (!isEncryptedField(value)) return "legacy";
  if (fieldKeyId(value) !== ring.activeId) return "rotate";
  // Also proves the value still decrypts under its key.
  decryptField(value, context);
  return null;
}

async function taxIds(prisma: PrismaClient) {
  const clients = await prisma.client.findMany({
    where: { taxIdEncrypted: { not: null } },
    select: { id: true, companyName: true, taxIdEncrypted: true },
  });
  for (const c of clients) {
    const value = c.taxIdEncrypted!;
    try {
      const work = needsWork(value, "Client.taxId");
      if (!work) {
        bump("tax IDs: already current");
        continue;
      }
      bump(work === "legacy" ? "tax IDs: plaintext → encrypted" : `tax IDs: re-encrypt onto ${ring.activeId}`);
      if (!apply) continue;
      if (work === "rotate") {
        await prisma.client.update({
          where: { id: c.id },
          data: { taxIdEncrypted: encryptField(decryptField(value, "Client.taxId"), "Client.taxId") },
        });
        continue;
      }
      if (checkTaxId(value).ok) {
        try {
          await prisma.client.update({ where: { id: c.id }, data: protectTaxId(value) });
          continue;
        } catch (err) {
          if ((err as { code?: string }).code !== "P2002") throw err;
          problems.push(`${c.companyName}: shares a tax ID with another client — encrypted without a uniqueness index; review it`);
        }
      } else {
        problems.push(`${c.companyName}: tax ID isn't 9 digits — encrypted as-is; correct it on the client's edit page`);
      }
      await prisma.client.update({
        where: { id: c.id },
        data: { taxIdEncrypted: encryptField(value.trim(), "Client.taxId"), taxIdLast4: looseLast4(value), taxIdIndex: null },
      });
    } catch (err) {
      problems.push(`${c.companyName} tax ID: ${err instanceof Error ? err.message : err}`);
    }
  }
}

async function ssns(prisma: PrismaClient) {
  const contacts = await prisma.corpContact.findMany({
    where: { ssnEncrypted: { not: null } },
    select: { id: true, ssnEncrypted: true },
  });
  for (const c of contacts) {
    const value = c.ssnEncrypted!;
    try {
      const work = needsWork(value, "CorpContact.ssn");
      if (!work) {
        bump("SSNs: already current");
        continue;
      }
      bump(work === "legacy" ? "SSNs: plaintext → encrypted" : `SSNs: re-encrypt onto ${ring.activeId}`);
      if (!apply) continue;
      if (work === "rotate") {
        await prisma.corpContact.update({
          where: { id: c.id },
          data: { ssnEncrypted: encryptField(decryptField(value, "CorpContact.ssn"), "CorpContact.ssn") },
        });
      } else if (checkSsn(value).ok) {
        await prisma.corpContact.update({ where: { id: c.id }, data: protectSsn(value) });
      } else {
        problems.push(`contact ${c.id}: SSN isn't a valid 9-digit SSN — encrypted as-is; review it`);
        await prisma.corpContact.update({
          where: { id: c.id },
          data: { ssnEncrypted: encryptField(value.trim(), "CorpContact.ssn"), ssnLast4: looseLast4(value) },
        });
      }
    } catch (err) {
      problems.push(`contact ${c.id} SSN: ${err instanceof Error ? err.message : err}`);
    }
  }
}

async function main() {
  if (apply && ring.isDevelopmentKey && !process.argv.includes("--allow-dev-key")) {
    throw new Error(
      "DATA_ENCRYPTION_KEYS isn't set, so this would encrypt with the public development key. " +
        "Set real keys (see .env.example), or pass --allow-dev-key for a throwaway local database."
    );
  }
  console.log(`Active key: ${ring.activeId}${ring.isDevelopmentKey ? " (DEVELOPMENT — not secret)" : ""}`);
  console.log(`Storage: ${objectStore.driver}\n`);

  const prisma = new PrismaClient();
  try {
    await documents(prisma);
    await taxIds(prisma);
    await ssns(prisma);
  } finally {
    await prisma.$disconnect();
  }

  for (const [k, n] of Object.entries(tally).sort()) console.log(`  ${k.padEnd(40)} ${n}`);
  if (Object.keys(tally).length === 0) console.log("  Nothing stored yet.");
  if (problems.length) {
    console.log(`\n${problems.length} item(s) need attention:`);
    for (const p of problems) console.log(`  - ${p}`);
  }
  const pending = Object.entries(tally).some(([k]) => !k.endsWith("already current"));
  if (!apply && pending) console.log("\nDry run — nothing changed. Re-run with --apply to do it.");
  if (problems.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
