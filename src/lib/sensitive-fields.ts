import { blindIndex, encryptField, keyRing, type KeyRing } from "@/lib/encryption";

// Tax IDs and SSNs: validation, masking, and the encrypted form that is stored.
//
// Pure (no next/*, no Prisma) — covered by scripts/test-encryption.ts.
//
// What the database holds for each:
//
//   Client.taxIdEncrypted   AES-256-GCM ciphertext (src/lib/encryption.ts)
//   Client.taxIdLast4       last four digits, for display and "search by last 4"
//   Client.taxIdIndex       keyed HMAC of the digits — unique, exact-match search
//
//   CorpContact.ssnEncrypted  AES-256-GCM ciphertext
//   CorpContact.ssnLast4      last four digits, for display
//
// The full value only ever exists in memory: on the way in (the form submit)
// and when somebody explicitly presses "Reveal", which is audited. Every list,
// report, export, search result and backup shows the masked form.
//
// Last-4 is stored in the clear on purpose. It's the industry-standard
// masked display (banks, the IRS's own truncated TINs on 1099s), it's what
// staff actually need day to day, and on its own it identifies nobody.

// All three US taxpayer numbers — EIN, SSN, ITIN — are nine digits.
const TIN_DIGITS = 9;

export function digitsOnly(value: string): string {
  return value.replace(/\D/g, "");
}

export type FieldCheck = { ok: true; digits: string } | { ok: false; reason: string };

export function checkTaxId(raw: string): FieldCheck {
  const digits = digitsOnly(raw);
  if (/[^\d\s-]/.test(raw.trim())) {
    return { ok: false, reason: "Tax ID can only contain digits, spaces and dashes." };
  }
  if (digits.length !== TIN_DIGITS) {
    return { ok: false, reason: "Tax ID must be 9 digits (EIN, SSN or ITIN)." };
  }
  if (/^0{9}$/.test(digits)) return { ok: false, reason: "That isn't a valid tax ID." };
  return { ok: true, digits };
}

// SSA rules: area 000, 666 and 900-999 are never issued; group 00 and serial
// 0000 are never issued. (900-series is ITIN, which belongs in Tax ID, not SSN.)
export function checkSsn(raw: string): FieldCheck {
  const digits = digitsOnly(raw);
  if (/[^\d\s-]/.test(raw.trim())) {
    return { ok: false, reason: "SSN can only contain digits, spaces and dashes." };
  }
  if (digits.length !== TIN_DIGITS) return { ok: false, reason: "SSN must be 9 digits." };
  const area = digits.slice(0, 3);
  if (area === "000" || area === "666" || area[0] === "9" || digits.slice(3, 5) === "00" || digits.slice(5) === "0000") {
    return { ok: false, reason: "That isn't a valid SSN." };
  }
  return { ok: true, digits };
}

export function formatSsn(digits: string): string {
  return `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`;
}

// EIN layout (XX-XXXXXXX). Used for the stored plaintext so a revealed tax ID
// reads the way people write it.
export function formatTaxId(digits: string): string {
  return `${digits.slice(0, 2)}-${digits.slice(2)}`;
}

export function maskTaxId(last4: string | null | undefined): string | null {
  return last4 ? `••-•••${last4}` : null;
}

export function maskSsn(last4: string | null | undefined): string | null {
  return last4 ? `•••-••-${last4}` : null;
}

export type ProtectedTaxId = { taxIdEncrypted: string; taxIdLast4: string; taxIdIndex: string };

export function protectTaxId(raw: string, ring: KeyRing = keyRing()): ProtectedTaxId {
  const check = checkTaxId(raw);
  if (!check.ok) throw new Error(check.reason);
  return {
    taxIdEncrypted: encryptField(formatTaxId(check.digits), "Client.taxId", ring),
    taxIdLast4: check.digits.slice(-4),
    taxIdIndex: taxIdIndexFor(check.digits, ring),
  };
}

export function taxIdIndexFor(digits: string, ring: KeyRing = keyRing()): string {
  return blindIndex(digits, "Client.taxId", ring);
}

export type ProtectedSsn = { ssnEncrypted: string; ssnLast4: string };

export function protectSsn(raw: string, ring: KeyRing = keyRing()): ProtectedSsn {
  const check = checkSsn(raw);
  if (!check.ok) throw new Error(check.reason);
  return {
    ssnEncrypted: encryptField(formatSsn(check.digits), "CorpContact.ssn", ring),
    ssnLast4: check.digits.slice(-4),
  };
}

// What a search box query can match on a protected tax ID: a full 9-digit
// number matches through the blind index, exactly 4 digits matches the last
// four. Anything else can't match a tax ID at all — there's deliberately no
// partial/substring search over an encrypted value.
export function taxIdSearch(query: string, ring: KeyRing = keyRing()): { index?: string; last4?: string } | null {
  const q = query.trim();
  if (!/^[\d\s-]+$/.test(q)) return null;
  const digits = digitsOnly(q);
  if (digits.length === TIN_DIGITS) return { index: taxIdIndexFor(digits, ring) };
  if (digits.length === 4) return { last4: digits };
  return null;
}
