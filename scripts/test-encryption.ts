// Encryption at rest, upload safety and sensitive-field handling.
// No framework, no database:
//
//   ./node_modules/.bin/tsx scripts/test-encryption.ts
import { randomBytes } from "node:crypto";
import {
  parseKeyRing,
  encryptFile,
  decryptFile,
  rewrapFileKey,
  encryptField,
  decryptField,
  fieldKeyId,
  isEncryptedField,
  blindIndex,
  sealBlob,
  openBlob,
  isSealedBlob,
  encryptionStatus,
  IntegrityError,
  DEV_KEY_ID,
  type KeyRing,
} from "../src/lib/encryption";
import {
  checkUpload,
  checkContent,
  safeFilename,
  mimeTypeFor,
  MAX_UPLOAD_BYTES,
} from "../src/lib/file-safety";
import {
  checkTaxId,
  checkSsn,
  maskTaxId,
  maskSsn,
  protectTaxId,
  protectSsn,
  taxIdSearch,
} from "../src/lib/sensitive-fields";
import { documentStorageKey, createObjectStore, type ObjectStore } from "../src/lib/storage";
import { storeDocumentBytes, readDocumentBytes, LegacyPlaintextError } from "../src/lib/document-vault";
import { upgradeRows } from "../src/lib/backup-format";
import { check, checkThrows, section, finish } from "./harness";

const k = () => randomBytes(32).toString("base64");
const K1 = k();
const K2 = k();
const IDX = k();

function ring(keys: string, index = IDX, env: Record<string, string> = {}): KeyRing {
  return parseKeyRing({ DATA_ENCRYPTION_KEYS: keys, DATA_INDEX_KEY: index, ...env } as unknown as NodeJS.ProcessEnv);
}

const r1 = ring(`k1:${K1}`);
const r21 = ring(`k2:${K2},k1:${K1}`);
const r2only = ring(`k2:${K2}`);

async function main() {
section("key ring");
check("first key is active", r21.activeId, "k2");
check("both keys loaded", [...r21.keys.keys()], ["k2", "k1"]);
check("not the development key", r21.isDevelopmentKey, false);
check("hex keys are accepted", ring(`h:${randomBytes(32).toString("hex")}`).activeId, "h");
checkThrows("a short key is refused", () => ring(`k1:${randomBytes(16).toString("base64")}`));
checkThrows("a duplicated id is refused", () => ring(`k1:${K1},k1:${K2}`), 'Key id "k1" appears twice in DATA_ENCRYPTION_KEYS.');
checkThrows("an entry without an id is refused", () => ring(K1));
checkThrows("the dev id is reserved", () => ring(`dev:${K1}`));
checkThrows("the index key can't equal an encryption key", () => ring(`k1:${K1}`, K1));
check("development fallback with nothing set", parseKeyRing({} as NodeJS.ProcessEnv).activeId, DEV_KEY_ID);
checkThrows("production refuses to run without keys", () =>
  parseKeyRing({ NODE_ENV: "production" } as unknown as NodeJS.ProcessEnv)
);
checkThrows("half-configured is refused", () => parseKeyRing({ DATA_ENCRYPTION_KEYS: `k1:${K1}` } as unknown as NodeJS.ProcessEnv));
check(
  "status reports production misconfiguration",
  encryptionStatus({ NODE_ENV: "production" } as unknown as NodeJS.ProcessEnv).ok,
  false
);

section("files — envelope encryption");
{
  const plain = Buffer.from("%PDF-1.7 W-2 for Jane Doe, SSN 123-45-6789");
  const enc = encryptFile(plain, "doc-1", r1);
  check("ciphertext does not contain the plaintext", enc.body.includes(Buffer.from("123-45-6789")), false);
  check("ciphertext starts with the format magic", enc.body.subarray(0, 4).toString(), "WFE1");
  check("keyId recorded", enc.keyId, "k1");
  check("round trip", decryptFile(enc.body, { documentId: "doc-1", ...enc }, r1).toString(), plain.toString());
  const again = encryptFile(plain, "doc-1", r1);
  check("same file twice → different ciphertext (fresh key + IV)", again.body.equals(enc.body), false);
  check("…and a different wrapped key", again.wrappedKey === enc.wrappedKey, false);

  checkThrows("a flipped byte fails integrity", () => {
    const bad = Buffer.from(enc.body);
    bad[30] ^= 1;
    decryptFile(bad, { documentId: "doc-1", ...enc }, r1);
  }, new IntegrityError().message);
  checkThrows("truncation fails integrity", () =>
    decryptFile(enc.body.subarray(0, enc.body.length - 1), { documentId: "doc-1", ...enc }, r1)
  );
  checkThrows("swapping a file into another document's row fails", () =>
    decryptFile(enc.body, { documentId: "doc-2", ...enc }, r1)
  );
  checkThrows("a different master key can't open it", () =>
    decryptFile(enc.body, { documentId: "doc-1", ...enc }, ring(`k1:${K2}`))
  );
  checkThrows("the key must still be in the ring", () =>
    decryptFile(enc.body, { documentId: "doc-1", ...enc }, r2only)
  );

  const rewrapped = rewrapFileKey({ documentId: "doc-1", ...enc }, r21);
  check("re-wrap moves onto the active key", rewrapped.keyId, "k2");
  check(
    "after re-wrap the old key can be dropped",
    decryptFile(enc.body, { documentId: "doc-1", ...rewrapped }, r2only).toString(),
    plain.toString()
  );
  const empty = encryptFile(Buffer.alloc(0), "e", r1);
  check("empty files work", decryptFile(empty.body, { documentId: "e", ...empty }, r1).length, 0);
}

section("fields");
{
  const sealed = encryptField("12-3456789", "Client.taxId", r1);
  check("self-describing prefix", sealed.startsWith("enc:v1:k1:"), true);
  check("no plaintext in it", sealed.includes("3456789"), false);
  check("isEncryptedField", [isEncryptedField(sealed), isEncryptedField("12-3456789"), isEncryptedField(null)], [true, false, false]);
  check("fieldKeyId", fieldKeyId(sealed), "k1");
  check("round trip", decryptField(sealed, "Client.taxId", r1), "12-3456789");
  check("decrypts after rotation while the old key is kept", decryptField(sealed, "Client.taxId", r21), "12-3456789");
  checkThrows("an SSN can't be moved into the tax ID column", () =>
    decryptField(encryptField("123-45-6789", "CorpContact.ssn", r1), "Client.taxId", r1)
  );
  checkThrows("plaintext is never returned as if it were protected", () => decryptField("123456789", "Client.taxId", r1));
  checkThrows("tampered ciphertext fails", () => decryptField(sealed.slice(0, -2) + "AA", "Client.taxId", r1));

  check("blind index is deterministic", blindIndex("123456789", "Client.taxId", r1), blindIndex("123456789", "Client.taxId", r21));
  check("…survives rotating the encryption key", blindIndex("123456789", "Client.taxId", r1) === blindIndex("123456789", "Client.taxId", r2only), true);
  check("…depends on the index key", blindIndex("123456789", "Client.taxId", r1) === blindIndex("123456789", "Client.taxId", ring(`k1:${K1}`, k())), false);
  check("…is separated by column", blindIndex("123456789", "Client.taxId", r1) === blindIndex("123456789", "CorpContact.ssn", r1), false);
}

section("tax ID and SSN rules");
check("EIN with dash", checkTaxId("12-3456789"), { ok: true, digits: "123456789" });
check("SSN-shaped tax ID", checkTaxId("123 45 6789").ok, true);
check("8 digits refused", checkTaxId("12-345678").ok, false);
check("letters refused", checkTaxId("12-34567AB").ok, false);
check("all zeros refused", checkTaxId("000000000").ok, false);
check("valid SSN", checkSsn("123-45-6789"), { ok: true, digits: "123456789" });
check("area 000 refused", checkSsn("000-12-3456").ok, false);
check("area 666 refused", checkSsn("666-12-3456").ok, false);
check("9xx (ITIN) refused as an SSN", checkSsn("912-34-5678").ok, false);
check("group 00 refused", checkSsn("123-00-4567").ok, false);
check("serial 0000 refused", checkSsn("123-45-0000").ok, false);
check("masks", [maskTaxId("6789"), maskSsn("6789"), maskTaxId(null)], ["••-•••6789", "•••-••-6789", null]);
{
  const t = protectTaxId("123456789", r1);
  check("protectTaxId stores last 4", t.taxIdLast4, "6789");
  check("protectTaxId stores it formatted", decryptField(t.taxIdEncrypted, "Client.taxId", r1), "12-3456789");
  check("protectTaxId index matches any formatting", t.taxIdIndex, protectTaxId("12-345-6789", r1).taxIdIndex);
  checkThrows("protectTaxId validates", () => protectTaxId("123", r1), "Tax ID must be 9 digits (EIN, SSN or ITIN).");
  const s = protectSsn("123 45 6789", r1);
  check("protectSsn", [s.ssnLast4, decryptField(s.ssnEncrypted, "CorpContact.ssn", r1)], ["6789", "123-45-6789"]);
  check("search: full number uses the index", taxIdSearch("12-3456789", r1), { index: t.taxIdIndex });
  check("search: last four", taxIdSearch("6789", r1), { last4: "6789" });
  check("search: partial numbers match nothing", [taxIdSearch("3456", r1) !== null, taxIdSearch("345678", r1), taxIdSearch("acme", r1)], [true, null, null]);
}

section("upload safety");
{
  const pdf = Buffer.from("%PDF-1.4\n...");
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
  const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]);
  const exe = Buffer.from("MZ\x90\x00 this program cannot be run in DOS mode", "latin1");
  check("real pdf", checkContent("a.pdf", pdf), { ok: true, filename: "a.pdf", mimeType: "application/pdf" });
  check("real png", checkContent("a.png", png).ok, true);
  check("real xlsx (zip container)", checkContent("a.xlsx", zip).ok, true);
  check("real jpeg", checkContent("a.JPG", Buffer.from([0xff, 0xd8, 0xff, 0xe0])).ok, true);
  check("csv text", checkContent("a.csv", Buffer.from("date,amount\n2026-01-01,10\n")).ok, true);
  check("OFX bank export", checkContent("bank.qbo", Buffer.from("OFXHEADER:100\nDATA:OFXSGML\n")).ok, true);
  check("an .exe renamed to .pdf is refused", checkContent("invoice.pdf", exe).ok, false);
  check("an html page renamed to .pdf is refused", checkContent("invoice.pdf", Buffer.from("<html><script>alert(1)</script>")).ok, false);
  check("html saved as .txt is refused", checkContent("notes.txt", Buffer.from("<!DOCTYPE html><html>")).ok, false);
  check("svg saved as .csv is refused", checkContent("data.csv", Buffer.from("\uFEFF<svg onload=alert(1)>")).ok, false);
  check("a shell script saved as .txt is refused", checkContent("run.txt", Buffer.from("#!/bin/sh\nrm -rf /")).ok, false);
  check("binary saved as .csv is refused", checkContent("a.csv", Buffer.from([0x41, 0x00, 0x42])).ok, false);
  check("a png renamed .jpg is refused", checkContent("a.jpg", png).ok, false);
  check("a non-OFX file renamed .qbo is refused", checkContent("x.qbo", Buffer.from("hello")).ok, false);
  check("svg is not allowed at all", checkUpload({ name: "logo.svg", size: 10 }).ok, false);
  check("html is not allowed at all", checkUpload({ name: "x.htm", size: 10 }).ok, false);
  check("oversized bytes refused", checkContent("a.pdf", Buffer.concat([pdf, Buffer.alloc(MAX_UPLOAD_BYTES)])).ok, false);
  check("mime comes from the extension", [mimeTypeFor("x.pdf"), mimeTypeFor("x.exe"), mimeTypeFor("x")], [
    "application/pdf",
    "application/octet-stream",
    "application/octet-stream",
  ]);

  check("path parts are stripped", safeFilename("../../etc/passwd.pdf"), "passwd.pdf");
  check("windows path parts are stripped", safeFilename("C:\\Users\\x\\W2.pdf"), "W2.pdf");
  check("RTL override trick is neutralised", safeFilename("invoice\u202Efdp.exe"), "invoicefdp.exe");
  check("control characters removed", safeFilename("a\u0000b\nc.pdf"), "abc.pdf");
  check("header-breaking quotes replaced", safeFilename('a"b.pdf'), "a_b.pdf");
  check("leading dots removed", safeFilename("...hidden.pdf"), "hidden.pdf");
  check("empty becomes 'file'", safeFilename("   "), "file");
  const long = safeFilename("x".repeat(400) + ".pdf");
  check("long names keep their extension", [long.length, long.endsWith(".pdf")], [180, true]);
  check("the checked name is the sanitized one", checkUpload({ name: "../W2\u202E.pdf", size: 5 }), {
    ok: true,
    filename: "W2.pdf",
    mimeType: "application/pdf",
  });
}

section("storage");
check("object keys are opaque — no filename", documentStorageKey("c1", "d1"), "clients/c1/d1.enc");
checkThrows("ids can't walk out of the key space", () => documentStorageKey("../x", "d1"), "Invalid storage key.");
checkThrows("NEXT_PUBLIC_ secrets are refused", () =>
  createObjectStore({ NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY: "x" } as unknown as NodeJS.ProcessEnv)
);
checkThrows("supabase driver needs its key", () =>
  createObjectStore({ STORAGE_DRIVER: "supabase", SUPABASE_URL: "https://x.supabase.co" } as unknown as NodeJS.ProcessEnv)
);
checkThrows("supabase must be https", () =>
  createObjectStore({ SUPABASE_URL: "http://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k" } as unknown as NodeJS.ProcessEnv)
);
check("local driver by default", createObjectStore({} as NodeJS.ProcessEnv).driver, "local");
check(
  "supabase driver when configured",
  createObjectStore({ SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k" } as unknown as NodeJS.ProcessEnv).driver,
  "supabase"
);

section("document vault");
{
  const objects = new Map<string, Buffer>();
  const memory: ObjectStore = {
    driver: "local",
    async put(b, key, body) {
      objects.set(`${b}/${key}`, Buffer.from(body));
    },
    async get(b, key) {
      const v = objects.get(`${b}/${key}`);
      if (!v) throw new Error("missing");
      return v;
    },
    async remove(b, key) {
      objects.delete(`${b}/${key}`);
    },
  };
  const plain = Buffer.from("%PDF-1.4 bank statement");
  const stored = await storeDocumentBytes({ documentId: "d1", clientId: "c1", bytes: plain }, { store: memory, ring: r1 });
  const inBucket = objects.get(`${stored.bucket}/${stored.storageKey}`)!;
  check("what reaches the bucket is ciphertext", inBucket.includes(Buffer.from("bank statement")), false);
  check("row metadata", [stored.encAlgorithm, stored.encKeyId, stored.storageKey], ["AES-256-GCM/envelope-v1", "k1", "clients/c1/d1.enc"]);
  const back = await readDocumentBytes({ id: "d1", ...stored }, { store: memory, ring: r1 });
  check("reads back", back.toString(), plain.toString());
  let refused = "";
  try {
    await readDocumentBytes({ id: "d1", bucket: stored.bucket, storageKey: stored.storageKey, encKeyId: null, encWrappedKey: null }, { store: memory, ring: r1 });
  } catch (err) {
    refused = err instanceof LegacyPlaintextError ? "legacy" : String(err);
  }
  check("a row with no key is refused, not served raw", refused, "legacy");
}

section("backups");
{
  const json = Buffer.from(JSON.stringify({ format: "workflow-backup", tables: { Client: [{ companyName: "Acme" }] } }));
  const blob = sealBlob(json, "backup", r1);
  check("sealed blob is recognisable", isSealedBlob(blob), true);
  check("a plain backup isn't mistaken for one", isSealedBlob({ format: "workflow-backup" }), false);
  check("no plaintext in the sealed blob", JSON.stringify(blob).includes("Acme"), false);
  check("opens", openBlob(blob, "backup", r1).toString(), json.toString());
  checkThrows("purpose is bound", () => openBlob({ ...blob, purpose: "other" }, "other", r1));
  checkThrows("other servers' keys can't open it", () => openBlob(blob, "backup", r2only));
  check(
    "v1 rows map taxId → taxIdEncrypted",
    upgradeRows("Client", [{ id: "c", taxId: "12-3456789" }], 1),
    [{ id: "c", taxIdEncrypted: "12-3456789" }]
  );
  check("v2 rows are untouched", upgradeRows("Client", [{ id: "c", taxIdEncrypted: "x" }], 2), [{ id: "c", taxIdEncrypted: "x" }]);
}

finish();
}

main();
