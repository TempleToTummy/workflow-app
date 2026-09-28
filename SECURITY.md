# Security: client files, tax IDs and SSNs

This app holds the most sensitive data an accounting firm has: tax returns,
bank statements, W-2s, EINs and Social Security numbers. This document is the
design for how that data is stored and accessed, what each layer protects
against, and the checklist for going live on Supabase.

## What is protected, and how

| Data | At rest | Who can read it | Logged |
|---|---|---|---|
| Uploaded files (staff Files tab and client request links) | AES-256-GCM, a unique key per file, wrapped by the master key (envelope encryption) | Staff assigned to that engagement, and admins | Every upload, download, deletion and refused upload |
| Client tax ID (EIN / SSN / ITIN) | AES-256-GCM field encryption, plus last 4 digits and a keyed HMAC index | Last 4: anyone who can open the client. Full number: an explicit "Reveal" | Every reveal and every change |
| Contact SSN | AES-256-GCM field encryption, plus last 4 digits | Same as tax ID | Every reveal and every change |
| Backup files (download, CLI, pre-restore snapshots) | The whole file is AES-256-GCM encrypted | Admins, on a server holding the same keys | Every download and restore |
| Everything else in the database | Supabase disk encryption (AES-256) and TLS in transit | The app server only; the Supabase REST API is locked out | The existing audit trail |

The keys (`DATA_ENCRYPTION_KEYS`, `DATA_INDEX_KEY`) exist **only in the app
server's environment**. They are never in the database, the bucket, a backup
or the browser.

## What each layer stops

| If an attacker gets… | What they have |
|---|---|
| A copy of the storage bucket (leaked service key, bucket made public by mistake, Supabase-side incident) | Ciphertext. Object names are opaque ids (`clients/<id>/<id>.enc`), not filenames. |
| A copy of the database (leaked connection string, SQL injection, a stolen dump) | Wrapped keys and ciphertext for files, tax IDs and SSNs. Names, addresses and emails are readable. |
| Both of the above | Still ciphertext. Decrypting needs the server's environment too. |
| A backup file left in a downloads folder or on a NAS | Ciphertext. |
| The project's public anon key | Nothing. `supabase/security.sql` removes every grant and turns on RLS for every table and the bucket. |
| A staff login | Only the engagements that person is assigned to. Full SSNs and tax IDs take a deliberate reveal (30 per 10 minutes), files are capped at 120 downloads per 10 minutes, and every reveal and download is in the audit log under their name. |
| Write access to the database, trying to swap one client's SSN or file into another's record | Nothing usable. Every ciphertext is bound to its document id or column, so a swapped value fails its integrity check. |
| A malicious upload (an `.exe` renamed to `.pdf`, an HTML/SVG page, a script) | A refusal. The file's bytes must match its type, and the refusal is logged. Even a file that got through could never run in the app, because downloads are always attachments with `nosniff` and a sandboxing CSP. |
| A deleted document | Nothing. Deleting the row destroys the file's only wrapped key ("crypto-shredding"), so leftover bytes in storage or a replica can't be opened. |

**Not covered:** anyone who controls the running app server has the keys and
the database, so they can read everything. That's true of every system that
has to show this data to its users. Defend the server: limit who can deploy,
keep secrets in the host's secret store, and require MFA on every host,
Supabase and GitHub account.

## The design

### Envelope encryption for files (`src/lib/encryption.ts`, `src/lib/document-vault.ts`)

1. The file is checked (see Uploads below) and given a document id up front.
2. A fresh random 256-bit data key (DEK) encrypts the file with AES-256-GCM.
   The document id is the additional authenticated data (AAD).
3. The DEK is encrypted ("wrapped") with a key-encryption key derived by HKDF
   from the active master key, and stored on the `Document` row as
   `encWrappedKey`, with `encKeyId` naming the master key.
4. Only the ciphertext (`WFE1 | IV | ciphertext | tag`) goes to storage.

Reading reverses this, and any tampering, truncation or swap fails the GCM tag
check. The route then returns an error and never serves partial or unverified
bytes. A row with no wrapped key was uploaded before encryption; the app
refuses to serve it until it has been migrated.

### Field encryption for tax IDs and SSNs (`src/lib/sensitive-fields.ts`)

- The value is validated (9 digits; SSNs are checked against SSA issuance
  rules) and stored as `enc:v1:<keyId>:<iv>:<ciphertext+tag>`, bound to its
  column.
- Screens, reports, CSV exports and search results show only `••-•••1234`.
- The edit forms are write-only. The stored value is never sent to the
  browser: leave the field blank to keep it, type a new one to replace it, or
  tick "Remove".
- Tax ID uniqueness and exact-match search use `taxIdIndex`, an HMAC-SHA256
  under the separate `DATA_INDEX_KEY`. Nine digits can't be brute-forced from
  that hash without the key. Search accepts a full 9-digit number or the last
  four digits, and never matches a partial number.
- The full value leaves the server only through `revealClientTaxId` or
  `revealContactSsn`. Both check access, are rate limited and write an audit
  row, and the value hides itself again after 30 seconds on screen.

### Keys and rotation

```bash
# Generate (run twice: one for the ring, one for the index key)
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

DATA_ENCRYPTION_KEYS="2026-09:<key>"          # first = active; later = old, decrypt-only
DATA_INDEX_KEY="<different key>"              # set once, never rotate
```

To rotate the encryption key (yearly, or right away if you suspect exposure):

1. Put the new key **first**: `DATA_ENCRYPTION_KEYS="2027-09:<new>,2026-09:<old>"`.
2. Deploy.
3. Run `npm run security:encrypt -- --apply`. This re-wraps every file's
   32-byte key and re-encrypts every field; files themselves are not
   re-uploaded.
4. Check that Admin → Backup & Restore → Data protection shows nothing on an
   older key, then remove the old key and deploy.

Backups made under the old key need the old key to restore. Keep retired keys
in the password manager for as long as you keep backups made with them.

**Losing the keys loses the data.** Store a copy somewhere that is neither the
app server nor Supabase, such as the firm's password manager (in a vault with
restricted access) or a cloud KMS.

Without keys in production (`NODE_ENV=production`), the app refuses to store
a file or a tax ID. Outside production, if neither variable is set, it uses a
public **development key** and logs a warning. Anything encrypted under that
key refuses to decrypt in production.

### Uploads (`src/lib/file-safety.ts`)

Staff uploads and client-link uploads go through the same checks:

- **An allow-list of extensions:** pdf, png, jpg/jpeg, gif, webp, tif/tiff,
  heic/heif, csv, txt, doc/docx, xls/xlsx, odt/ods, zip, and the ofx/qfx/qbo
  bank exports. Nothing executable, and nothing a browser renders as a page
  (html, svg, xml).
- **Content verification:** the file's first bytes must match its extension.
  Text formats are rejected if they contain binary data, or if they start as
  HTML, SVG, PHP or a script.
- **A 15 MB cap**, enforced both before and after the bytes are read.
- **Filename sanitising:** path parts, control characters and Unicode
  direction overrides (the `invoice‮fdp.exe` trick) are removed, and the
  length is bounded.
- **Server-assigned content type:** the stored and served type comes from the
  allow-list, never from what the browser reported.

### Downloads (`src/app/api/documents/[id]/route.ts`)

A download requires a signed-in user assigned to the engagement (a user who
isn't gets 404, not 403). Each person is limited to 120 downloads per 10
minutes, and every download writes an audit row. Responses always carry:

```
Content-Disposition: attachment; filename*=UTF-8''…
X-Content-Type-Options: nosniff
Content-Security-Policy: default-src 'none'; sandbox
Cache-Control: private, no-store, max-age=0
Cross-Origin-Resource-Policy: same-origin
```

### App-wide headers (`next.config.ts`)

- HSTS (2 years, preload)
- `X-Frame-Options: DENY` and `frame-ancestors 'none'`
- `nosniff`
- `Referrer-Policy: no-referrer`, so client request tokens in `/r/…` URLs
  can't leak to other sites
- A restrictive `Permissions-Policy`
- `Cross-Origin-Opener-Policy: same-origin`
- `base-uri`, `form-action` and `object-src` locked down
- No `X-Powered-By`
- Client request pages are also `no-store` and `noindex`

## Going live on Supabase

1. **Create the project** in a US region. Turn on MFA for every organization
   member, and keep the member list to the people who need it.
2. **Point Prisma at Postgres.** In `prisma/schema.prisma`, set
   `provider = "postgresql"`. Set `DATABASE_URL` to the Prisma connection
   string with `?sslmode=require`.
3. **Set the server environment** in your host's secret store (e.g. Vercel →
   Settings → Environment Variables, marked *Sensitive*), not in a committed
   file:
   - `DATABASE_URL`
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `DATA_ENCRYPTION_KEYS`
   - `DATA_INDEX_KEY`
   - `AUTH_SECRET`
   - `CRON_SECRET`
   - `APP_URL`

   None of these may have a `NEXT_PUBLIC_` prefix; the app refuses to start
   if one does.
4. **Create the tables:** `npx prisma db push`.
5. **Lock it down:** run [`supabase/security.sql`](supabase/security.sql) in
   the SQL editor. It creates the private `workflow-files` bucket (ciphertext
   only, 16 MB cap), adds a restrictive deny policy for the API roles, revokes
   every grant from `anon` and `authenticated`, turns on RLS for every table,
   and installs a trigger that does the same for future tables. The
   verification queries at the end must come back empty (the bucket row must
   show `public = false`).
6. **Make the dashboard changes** listed at the top of that script:
   - Turn off the Data API, or stop exposing `public`.
   - Disable Supabase Auth sign-ups.
   - Enforce SSL.
   - Add network restrictions.
   - Enable Point-in-Time Recovery.
7. **Move data across, if any:** take a backup on the old server (it's
   encrypted, so the new server needs the same keys), restore it on the new
   one, then run `npm run security:encrypt` (a dry run) followed by
   `npm run security:encrypt -- --apply`.
8. **Verify:** Admin → Backup & Restore → Data protection should show keys
   configured, Supabase Storage, and zero unencrypted items. Upload a file,
   then confirm in the Supabase Storage browser that it's an opaque `.enc`
   object that doesn't open as a document.
9. **Back up the keys** to the firm's password manager, and schedule
   `npm run db:backup` to write somewhere off-server.

## Upgrading an existing database

On a database that predates this change, `npx prisma db push` warns about
adding a unique constraint on `Client.taxIdIndex` and asks for
`--accept-data-loss`. The column is new and empty, so nothing is lost; the
existing `taxId` column and its values are kept (the Prisma field is now
`taxIdEncrypted`, mapped to the same column). Then run
`npm run security:encrypt -- --apply`. Until you do, the app refuses to serve
pre-encryption files or reveal pre-encryption tax IDs and SSNs.

## Not covered yet

These are the known gaps, in rough order of priority:

- **Upgrade Next.js.** `next@16.3.1` has a published advisory (`npm audit`).
- **Enforce 2FA.** Two-factor is available but not mandatory. Make it
  mandatory for everyone before real data goes in; the FTC Safeguards Rule
  expects MFA for anyone accessing customer information.
- **Shared rate limits.** Rate limits (login, reveal, download) are
  in-memory, per server process. On a multi-instance or serverless deploy,
  move them to Postgres or a shared cache, or each instance gets its own
  allowance.
- **Malware scanning.** Uploads are type-checked, content-checked,
  encrypted and never rendered inline, but not scanned. If the firm opens
  client files on workstations, add a scanner (e.g. ClamAV or a cloud scanning
  API) in `checkContent` before encryption.
- **A key management service.** Keys are environment variables. The next
  step up is a cloud KMS or HSM, so the master key never leaves it and every
  unwrap is logged by the provider. The key ring in `src/lib/encryption.ts`
  is the one place that would change.
- **Encrypting other fields.** Only tax IDs and SSNs are field-encrypted.
  Names, addresses, emails, notes and file names rely on Supabase's disk
  encryption and the lockdown above. Don't put SSNs in free-text notes or
  file names.
- **A strict script CSP.** The CSP doesn't restrict scripts yet; that needs
  a per-request nonce (see the Next docs on Content Security Policy).
- **TOTP secret encryption** still uses the older `AUTH_SECRET`-derived key
  (`src/lib/secret-box.ts`). It's separate from, and unaffected by, the key
  ring above.

## Compliance notes

These controls cover the technical safeguards that the FTC Safeguards Rule
(16 CFR 314.4(c)) and IRS Publication 4557 expect a tax preparer to have:
encryption of customer information at rest and in transit, access limited to
authorized users, and monitoring and logging of that access. They are not the
whole program. The firm still needs a written information security plan
(WISP), a named qualified individual, staff training, an incident response
plan, and vendor oversight (a Supabase DPA, and Supabase's SOC 2 report).
