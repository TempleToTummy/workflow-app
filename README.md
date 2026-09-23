# Workflow Dashboard

A Next.js + Prisma rebuild of the KTAX workflow app, matching the real
schema (clients, recurring project templates with ordered subtasks,
per-period task tracking) pulled from the original Oracle APEX export.

## Running it locally

```bash
npm install
npx prisma generate
npx prisma db push      # creates the local SQLite database from the schema
npx prisma db seed      # loads sample clients, projects, and tasks
npm run dev
```

Then open http://localhost:3000. You'll be sent to `/login`.

Updating an existing checkout? Run `npm install` and `npx prisma db push` after
pulling — new features add tables and columns (all additive; no data is lost).

## Signing in

The seed creates one working account:

```
email:    admin@workflow.test
password: admin1234
```

Everyone else (`priya@`, `marcus@`, `dana@firm.test`) is **invite-pending**:
no password yet. As the admin, open **Admin Menu → Employees**, hit **Copy
link** on a row, and send that `/invite/<token>` URL to the person — they set
their own password and land in the app. Roles are **Admin** or **Employee**;
an admin flips a role from the Employees table. Employees see and work only the
engagements they have a task on (see **Permissions** below).

To change the admin password, edit `ADMIN_PASSWORD` in `prisma/seed.ts` and
re-seed, or use **Revoke** on the admin row and accept a fresh invite.

### How auth works

Self-contained, no external service: passwords are `scrypt`-hashed
(`src/lib/password.ts`), a `Session` row backs an httpOnly `wf_session` cookie
(`src/lib/auth.ts`), and access is enforced in two layers — `src/proxy.ts`
(bounces logged-out visitors to `/login`) and `requireUser()` /
`requireAdmin()` at the top of every page, `src/app/admin/layout.tsx`, and
every server action. Invite links are copied by hand; there's no email sender.

Once signed in, the dashboard is a table of every client's active project with
a live status and progress count. Click into any row to see the ordered task
checklist and change task status, sequential completion is enforced the same
way the original app's trigger enforced it, you can't mark a task Done while
an earlier task in the same period is still open.

## Permissions

Writing needs the same access as reading. Every server action checks it
(`src/lib/permissions.ts` is the policy, `src/lib/access.ts` enforces it), so an
id guessed or kept from an old assignment gets nowhere:

| Who | Can |
| --- | --- |
| Employee, on an engagement (has a task on that client + service, any period) | Work it: step status, assignees, subtasks, notes, files, comments, timers, client requests, the engagement's deadline override and default owner |
| Employee, on any of a client's engagements | Edit that client's details, contacts and tags |
| Admin | All of the above for every client, plus firm structure: add / archive / delete clients, turn services on for a client, and edit service templates (checklist steps, due rules, step owners, estimates) |

Employees see service templates read-only, since a template change alters every
client on that service. A refusal never says whether the record exists. Notes
and uploads are recorded under the signed-in user (the old "Author…" picker is
gone), and only a note's author or an admin can edit or delete it. File
downloads, the client edit page and the email template preview follow the same
rules.

## Search

The box at the top of the sidebar (press **/** anywhere) searches clients (name,
group, email, phone, tax ID, city, note, tags), contacts, services, checklist
steps and their notes, task comments, engagement notes, file names and email.
Results are grouped with the match highlighted; each group can be opened on its
own. Every group is scoped exactly like the page it links to, so an employee
only finds things on the engagements they're assigned to.

## Bulk actions

- **Tasks** — tick rows (or the header box for everything shown), then **Set
  status** or **Assign to**. Bulk *Done* follows the checklist order per
  engagement: selecting steps 1, 2 and 3 marks all three, but a step whose
  earlier step is still open is skipped and the result says which step it's
  waiting on. Finishing a period in bulk rolls it forward like doing it by hand.
- **Dashboard** — tick rows and **Assign open steps to…** someone (optionally
  only the unassigned ones). Done steps keep whoever did them.
- **Clients** — tick clients to **Add tag** or **Set group** in one go.

Rows you can't access are skipped and counted, never silently changed; every
change is written to the activity log individually.

## Groups, tags and saved views

- **Groups** use the client's *Group Name* (one per client, e.g. "Smith Family").
  Filter by group on the dashboard, tasks and clients pages, or switch the client
  list to **By group**. The client form suggests existing group names.
- **Tags** are labels a client can have many of ("VIP", "Needs 1099s"). Add them
  on a client's page (typing an existing tag in any case reuses it) or in bulk;
  filter by tag anywhere groups can be filtered. Admins rename, recolour and
  delete tags under **Admin Menu → Client Tags**.
- **Saved views** — on the dashboard and tasks list, **Views → Save current view…**
  names the filters you have applied. Admins can share a view with the whole
  team. The button shows which view is active.

## Archiving clients

**Archive client** (admin, on the client's page) replaces delete. An archived
client disappears from the dashboard, tasks, projects, workload, reports, CSV
exports, search and pickers; the scheduler stops opening periods for it; and any
open client-request links are revoked. Nothing is removed — history, files and
time stay — and **Clients → Archived → Restore client** brings it back, resuming
its services from the *current* period rather than generating the months it was
archived. **Delete permanently** is only offered for an archived client with no
history at all, and asks you to type the client's name.

## Backup and restore

**Admin Menu → Backup & Restore**:

- **Download backup** — one JSON file with every table (optionally including
  uploaded files). It restores into SQLite or Postgres alike. Sessions and
  pending invite/reset links are left out. Downloads are audited.
- **Restore** — choose a file, **Check file** to compare its contents with what's
  there now, type `RESTORE`, and it replaces everything in a single transaction
  (a bad file changes nothing). The current data is saved as a snapshot first, so
  restoring the wrong file can be undone. Everyone is signed out afterwards.

From the command line (for cron, or when the app won't start):

```bash
npm run db:backup                        # → backups/workflow-backup-<date>.json
npm run db:backup -- --files --keep 30   # include files; keep the newest 30
npm run db:restore -- backups/<file>.json        # dry run: shows what's in it
npm run db:restore -- backups/<file>.json --yes  # replace all data
```

Set `BACKUP_DIR` to put backups somewhere that outlives the server. The file
holds client tax IDs, contacts and password hashes — store it like the database.

## Two-factor authentication and sessions

Everyone has an **Account & security** page (click your name at the bottom of the
sidebar):

- **Two-factor authentication** — scan the QR code with any authenticator app,
  confirm with a code, and save the ten one-time recovery codes shown. After
  that, sign-in asks for a code after the password. A used code can't be
  replayed; wrong codes are rate limited. A password reset on a 2FA account
  still asks for the code. Turning 2FA off or making new recovery codes needs
  your password. Admins are prompted to turn it on.
- **Where you're signed in** — every session with its device, IP and last
  activity. Sign one out, or all but this browser.
- **Password** — change it (current password required); other devices are
  signed out by default.

Admins see each person's 2FA status and session count on **Employees**, with
**Reset 2FA** (lost phone *and* recovery codes) and **Sign out everywhere**.
Revoking someone's access also clears their 2FA.

Set `AUTH_SECRET` in the server environment to encrypt 2FA secrets at rest
(AES-256-GCM). Without it they're stored unencrypted and the Account page says
so. Don't change `AUTH_SECRET` after people have enrolled.

## Due dates

A due date is not "the last day of the accounting period" — sales tax for
August is due September 20th, a calendar-year business return is due March
15th. Deadlines are resolved from three layers, each falling back to the one
above it:

| Layer | Field | Means |
| --- | --- | --- |
| Service rule | `Project.dueOffsetDays` | Days **after** the period ends. `0` = last day of the period. |
| Client override | `ProjectClientMap.dueOffsetDays` | This client is different (extension on file, negotiated turnaround). `null` = inherit. |
| Step milestone | `ProjectTaskMap.dueOffsetDays` | Relative to the engagement's deadline. Negative = earlier. `null` = due with the project. |

The resolved date is stored on `ClientActivity.dueDate`, so the dashboard sorts
and filters in the database. Changing any rule recomputes the affected rows —
except rows someone dated by hand (`dueDateOverridden`), which are left alone
so a recorded extension survives a rule change.

Set a service's rule on its project page (**Due date rule**, with presets for
the common filing deadlines), a step's milestone on the chip beside it in the
checklist builder, and a client's override in the **Deadline** panel on the
assignment page. Click any step's date on the checklist to pin it by hand.

The math lives in `src/lib/due-dates.ts`. Seeded rules cover federal statutory
deadlines only (1099 Jan 31, business return Mar 15, individual return Apr 15);
everything else starts at `0` for the firm to set rather than being guessed at.

If you have a database that predates this, date its existing rows once:

```bash
./node_modules/.bin/tsx prisma/backfill-due-dates.ts
```

## Scheduled work generation

Each accounting period's checklist has to appear on its own. It used to appear
only as a side effect of someone ticking the *previous* period's last task
done, which meant an engagement that fell behind silently stopped producing
work at all.

`src/lib/scheduler.ts` walks every active engagement from the period it's
parked in up to the period today falls in and opens each one, finished or not.
It's idempotent — running it twice creates nothing the second time.

Point a daily cron at it:

```bash
curl -X POST https://<host>/api/cron/generate-periods \
     -H "Authorization: Bearer $CRON_SECRET"
```

`vercel.json` already declares that as a daily 06:00 UTC cron. On Vercel, set
`CRON_SECRET` as an environment variable and it's sent for you.

With no scheduler attached (the default when running locally), the dashboard
lazily runs the job itself if no successful run has happened in the last six
hours, so the board is never built from stale data. Set `PERIOD_AUTOGEN=off` to
turn that off and rely on cron alone.

**Admin Menu → Work Generation** (`/admin/scheduler`) shows run history, warns
when the last successful run is over 24 hours old, has a **Run now** button,
and lists any engagement still behind the current period with the reason.

## Email

A firm-wide **Email** section in the sidebar: every message to and from clients,
threaded onto the engagement it's about.

- **Tabs** — All, Sent, Received, Needs attention (failed / bounced / stuck in
  the queue), and Unmatched (inbound mail we couldn't attach to a client, which
  only appears when there is some). Filter by client, project and status, or
  search subject, body and address.
- **Templates** (`/email/templates`) — reusable messages keyed to the checklist
  steps that actually require writing to a client: request documents, chase
  missing documents, report ready for review, review reminder, signature
  request (8879), deadline approaching, period closed. `{{placeholders}}` are
  resolved per engagement, so the same template says the right thing for every
  client — including live values like the open task count, the next open step,
  and the resolved due date. Admins can edit and add templates; the editor
  flags a placeholder that won't resolve.
- **Threads** — opening any message shows the whole conversation with a reply
  box that stays inside it. A failed message can be retried in place rather
  than recomposed.

### Sending

Transport is swappable, the same shape as `src/lib/storage.ts`:

| Transport | When | Behaviour |
| --- | --- | --- |
| `LogTransport` | default, no config | Records the message, delivers nothing. Shows as **Not sent** everywhere, never as Sent. |
| `ResendTransport` | `RESEND_API_KEY` is set | POSTs to `api.resend.com` with `fetch`. No new dependency. |

```bash
RESEND_API_KEY="re_..."          # unset = record only, nothing delivered
EMAIL_FROM="workflow@yourfirm.com"
EMAIL_FROM_NAME="Your Firm"
```

To use a different provider, write a class with the same `send` and change
`pickTransport` in `src/lib/email.ts`. Nothing else changes — `providerId` and
`transport` on the row already hold whatever comes back.

### Receiving replies

Every outbound message carries a `Reply-To` of
`<prefix>+<token>@<inbound domain>`, so a reply can be threaded onto the exact
engagement it belongs to instead of being guessed at from the subject line.

```bash
EMAIL_INBOUND_DOMAIN="reply.yourfirm.com"
EMAIL_INBOUND_PREFIX="reply"
EMAIL_INBOUND_SECRET="whsec_..."   # unset = the webhook refuses everything
```

For the domain, either use the managed `<id>.resend.app` address Resend gives
you (no DNS at all) or add an MX record on your own subdomain — it must have the
lowest priority value or mail won't route to Resend. Then create a received-mail
webhook pointing at `POST /api/email/inbound`. The endpoint verifies Svix-style signature headers
(what Resend sends), a plain `x-webhook-signature` HMAC, or a bearer token, and
rejects anything more than five minutes old.

Resolution order for an incoming message: the reply token in the `To:` address;
failing that, the sender matched against client contacts and client addresses;
failing that, it's stored unattached and shows under **Unmatched** so nothing is
lost.

Resend's `email.received` webhook carries **metadata only** — sender, recipients,
subject, attachment list, and an `email_id`. The body is not in the payload. The
route detects that and fetches it with `GET /emails/receiving/{id}` (which needs
`RESEND_API_KEY`, so the same key does both directions). If that follow-up call
fails the message is still stored from the webhook metadata, with a note in the
body saying the content couldn't be retrieved, rather than being dropped or
silently stored blank.

> Other providers put the body inline, and the parser handles that too — it
> reads the union of the common field spellings. Confirm the field names against
> your provider's actual webhook before relying on it in production.

Run the library's tests (no framework needed):

```bash
./node_modules/.bin/tsx --env-file=.env scripts/test-email.ts
```

## Password reset

"Forgot your password?" on the sign-in page → `/forgot-password` → a single-use
link, valid for **1 hour**.

- The request form answers **identically whether or not the account exists**, so
  it can't be used to discover who works here.
- Only a **SHA-256 hash** of the token is stored. The raw token lives in the
  email, so a database read isn't enough to take over an account. (Plain SHA-256
  is correct here, not scrypt: the input is already 256 bits of randomness, so
  there is nothing to brute force.)
- Redeeming a link **ends every other session** on that account, settles any
  outstanding invite, and signs the user in.
- Sign-in and reset requests are **rate limited** (`src/lib/rate-limit.ts`) —
  the login form previously had no throttling at all.

Because no mail provider is configured, the reset email is recorded but not
delivered. So **Admin Menu → Employees** has a **Reset password** button on every
active account that mints a link to hand over directly, mirroring the existing
invite flow. Every use is audited — issuing one is a way to take over an account.

Set `APP_URL` in a deployment behind a proxy; otherwise links are built from the
request's own host.

## Audit trail

**Insights → Activity log** (`/activity`, admin-only) records who changed what,
and when: task status, assignees, due dates, engagement and period creation,
due-date rules, default assignees, sign-ins and failed sign-ins, password resets,
invites, role changes, access revocation, and client create/update/delete.

Three rules make it worth having rather than a second set of timestamps:

- **Append-only.** Nothing in the app updates or deletes an `AuditEvent`.
- **No foreign keys.** History outlives what it describes — deleting a client
  doesn't erase the record of what was done to it. Ids are plain strings and
  every row carries a denormalized label so it stays readable afterwards.
- **Recording never breaks the operation.** A failed audit write is logged and
  swallowed; refusing to mark a task done because the audit insert failed would
  be the worse outcome.

`ClientActivity` also gained `completedAt` / `completedById`, so **"who signed off
Reviewer Layer 2, and when"** has a real answer — it shows inline on each done
step. `updatedAt` couldn't serve: any later edit to notes or assignee clobbered
it. Re-opening a step clears the stamp rather than leaving a withdrawn sign-off
on the record.

Each engagement also has its own **History** panel on the assignment page,
visible to anyone who can already open that engagement.

## Default assignees

Every rolled-forward period used to arrive completely unassigned, so somebody
re-assigned the same people to the same steps every month. Two layers now fill
them in at generation time:

| Layer | Where | Means |
| --- | --- | --- |
| Step owner | Project page, per checklist step | "Reviewer Layer 2 is always Marcus" |
| Engagement owner | Assignment page → Default owner | "Dana owns Bluepoint's bookkeeping" |

**The step owner wins; the engagement owner fills in the rest.** A step owner
expresses a role or skill — the person who does second review does second review,
regardless of whose client it is — while the engagement owner is the catch-all.
Resolving it the other way would let a client owner silently take over a
specialist sign-off, which is the opposite of what a reviewer layer is for.

Neither is retroactive: changing a default affects rows generated from then on,
never existing work. **Apply to unassigned steps** on the assignment page is the
explicit way to push defaults onto the period already on screen, and it only
fills blanks — it never reassigns work someone has picked up.

```bash
./node_modules/.bin/tsx scripts/test-workflow-rules.ts   # precedence, tokens, rate limits
```

## Time tracking

A timer on any checklist step, manual entry, and rollups.

- **Timer.** Press Start on a step. The clock shows in the step and in the
  sidebar, so it can be stopped from anywhere. Starting a timer on a second
  step stops the first one and tells you what it logged — switching tasks is
  normal, and nothing is lost by it. **Discard** throws away a timer started
  by mistake; it is only ever offered while a timer is running, so it can
  never erase recorded time.
- **Manual entry.** `/time`, or the Time tab on an engagement. The duration
  box takes `90`, `1:30`, `1.5h` or `1h 30m` and echoes back how it read it
  before you submit. A bare number means **minutes**.
- **Rollups.** `/reports/time-summary` — per employee, per client and per
  service, with realization (billable ÷ total) and value.

Two rules worth knowing:

- A **billing rate is frozen onto each entry** when the time is logged
  (`TimeEntry.rateSnapshot`). Raising somebody's rate does not restate work
  already recorded. Set rates and weekly capacity in Admin → Employees.
- **An unset rate is unknown, not zero.** Money shows as `—` rather than
  `$0.00`, and a rollup that could only price some of its hours says how many
  it covered.

Employees see only their own time, and never a money figure. A timesheet is
personal data and a rate is commercially sensitive.

A timer left running is capped at 16 hours when stopped, flagged, and given a
note asking you to correct it — rather than silently producing a 400-hour
entry.

## Workload

`/workload` (admin) shows what each person is carrying: open tasks, committed
hours, load against their weekly capacity, and when it is all due.

For hours to mean anything, steps need estimates. Set one on a project's
checklist (Projects → open a service → the `est.` chip on a step); every task
generated from then on carries it, and it is editable per task on the
engagement. Like the due-date rules, changing a template estimate is **not**
retroactive — per-task estimates are routinely corrected for a specific
client, and a template tidy-up must not overwrite the better number.

Work with no estimate is reported as unestimated, never counted as zero hours,
and the load bar only appears where there is both a capacity and at least one
estimate.

## Client requests

The checklist has two steps that wait on the client — "Document Received" and
"Review done by Client". This is how you ask for them.

From an engagement, **Client requests → Ask client**. Pick the blocked step
(the wording fills itself in), choose whether you need a file or an approval,
and create the link. It is emailed to the client's contact address if one is
on file, and always shown for copying.

The client opens `/r/<token>` — no account, no password — and either sends a
file or approves. Their answer is posted into the task's discussion and any
file lands in that period's Files tab.

- The link expires after **14 days** and can be revoked instantly.
- The raw token is shown **once**, at creation. "Re-issue link" mints a new
  one and kills the old — which is also how you fix a link forwarded to the
  wrong person.
- Only a hash of the token is stored, so reading the database doesn't reopen
  a client's request.
- Uploads are limited to documents, spreadsheets, images and PDFs, 15 MB each.
- Answering a request does **not** tick the checklist step. A client's upload
  can't satisfy a reviewer sign-off; staff still close the step. What this
  removes is the waiting and the chasing.

`/requests` (admin) lists everything outstanding, sorted so the ones needing a
phone call come first, and shows whether the client has even opened the link.

## Task comments

Each checklist step has a discussion thread — expand the step to see it.
`ClientActivity.notes` is a single field that the second person to edit
overwrites, which is exactly wrong for a reviewer handoff; comments replace it
as the place a conversation happens.

- One level of replies, so a handoff stays readable.
- Type `@` and a colleague's name to pull them in. The composer confirms who
  was notified, and **tells you when a name matched nobody** — that is the
  failure that matters, because you think you just handed the task over.
- Two people with the same first name? `@Dana` notifies neither and asks for
  the full name, rather than guessing.
- Mentions land in `/mentions`, with an unread count in the sidebar.
- Editing a comment does not notify anyone new — post a new comment for that.

## Export and print

Every report has **Export CSV** and **Print** in its top-right corner, as do
`/time`, `/workload` and `/requests`.

- CSVs open cleanly in Excel (BOM, CRLF, RFC 4180 quoting) and are protected
  against spreadsheet formula injection, which matters because client notes
  are free text.
- Matrix reports flatten to one row per cell so they can be pivoted.
- Printing drops the sidebar and the controls, keeps status colours, repeats
  table headers across pages and stamps the date.
- Exports honour the same permissions as the pages: firm-wide reports are
  admin-only, and an employee exporting their own timesheet gets hours without
  rate columns.

## What's here

- `prisma/schema.prisma` — the data model. Comments at the top explain what
  was carried over from the Oracle schema and what was deliberately left out
  (the old login tables, the plaintext password field).
- `prisma/seed.ts` — sample data: a few clients, two project templates
  (monthly bookkeeping, quarterly sales tax), and generated task rows.
- `src/lib/workflow.ts` — the sequencing rules (deriving an assignment's
  overall status, checking whether a task is allowed to be marked Done).
- `src/lib/actions.ts` — server actions: updating a task's status, creating
  a client, assigning a project to a client (this is what generates that
  assignment's first batch of task rows, same job the original
  `TRG_PROJ_CLIENT_INSERT_SUBTASKS` trigger did), and the due-date rules.
- `src/lib/due-dates.ts` — how a deadline is resolved from the three layers
  above. Pure, no `next/*` imports, so scripts can reuse it.
- `src/lib/scheduler.ts` — the scheduled job that opens each engagement's
  accounting periods, plus the single row generator every path shares.
- `src/lib/audit.ts` — the audit recorder and the vocabulary of actions.
  `src/lib/default-assignees.ts` — the two-layer assignee precedence.
  `src/lib/rate-limit.ts` — throttling for sign-in, password reset and the
  public client-request endpoints.
- `src/lib/time.ts` — duration parsing, rollups, realization and date ranges.
  `src/lib/workload.ts` — capacity maths. `src/lib/mentions.ts` — @mention
  resolution. `src/lib/csv.ts` — CSV generation and the injection guard.
  `src/lib/client-requests.ts` — the magic-link access decision and upload
  rules. All pure, no `next/*` imports, all covered by `npm test`.
- `src/lib/time-actions.ts`, `src/lib/comment-actions.ts`,
  `src/lib/client-request-actions.ts` — the server actions for each; the
  matching `*-data.ts` modules hold the reads (deliberately NOT `"use server"`,
  so queries aren't published as POST endpoints).
- `src/lib/report-export.ts` — one row builder per CSV export, served by
  `src/app/api/export/[report]/route.ts`.
- `src/components/error-state.tsx` / `skeleton.tsx` — the shared bodies behind
  every `error.tsx`, `not-found.tsx` and `loading.tsx`.
- `src/lib/email.ts` — the mail transport, reply-token threading, template
  rendering, and webhook signature verification. `src/lib/email-actions.ts`
  holds the server actions; `prisma/email-templates.ts` the built-in messages.
- `src/lib/permissions.ts` / `src/lib/access.ts` — who may change what, and the
  checks every action runs. `src/lib/bulk.ts` + `bulk-actions.ts` — bulk
  status/assign. `src/lib/organize-actions.ts` — tags, groups, saved views.
  `src/lib/backup.ts` + `backup-format.ts` — backup and restore.
  `src/lib/totp.ts`, `secret-box.ts`, `account-actions.ts` — 2FA, secret
  encryption, sessions. `src/lib/search.ts` + `search-data.ts` — global search.
- `src/app/page.tsx` — the dashboard.
- `src/app/assignments/[clientId]/[projectId]/page.tsx` — the checklist
  view for one client's project.

## Moving to Supabase

1. Create a Supabase project (supabase.com), grab the connection string
   from Project Settings → Database.
2. In `prisma/schema.prisma`, change the datasource provider from
   `sqlite` to `postgresql`.
3. Put the Supabase connection string in `.env` as `DATABASE_URL`.
4. Run `npx prisma db push` again, this time it creates the tables in
   Supabase's Postgres instead of the local SQLite file.
5. Run `npx prisma db seed` again if you want the sample data there too, or
   skip it and start entering real clients.

## Tests

```bash
npm test     # 550 assertions across twelve scripts, no framework, no database
```

Among them: `test-core-rules.ts` covers the rules the app stands on —
`canMarkDone`, `deriveAssignmentStatus`, `dueBucket` (including Sunday/Monday and
year boundaries) and `nextPeriodName` / period ranges — plus the permission
policy; `test-security.ts` checks TOTP against the RFC 6238 test vectors.

Every rule worth testing lives in a pure module with no `next/*` and no Prisma
import, so `tsx script.ts` is a complete test runner. See `scripts/`.

## Not built yet

- **Enforced 2FA.** Two-factor is strongly recommended to admins but not
  required of anyone; a firm-wide "must enrol" policy would be a small addition
  on top of what's here.
- **Scheduled backups inside the app.** `npm run db:backup` is built for cron, but
  nothing runs it for you, and backups aren't encrypted — keep them on storage
  you trust.
- **Postgres full-text search.** Search uses `contains` (SQLite `LIKE`), which is
  fine at firm scale; a large database would want a proper index.

- **Automatic** notifications. Email is wired up and reusable, but nothing
  sends on its own except a client-request link and a password reset: nobody
  is emailed when they're assigned work, no digest goes out when a deadline is
  close, and an @mention shows in the app but is not emailed.
  `sendEmailMessage` in `src/lib/email-actions.ts` is the hook.
- **Timesheet locking.** Entries can be corrected at any time, including for a
  period already invoiced. Every edit and delete is audited, but nothing
  freezes a timesheet — add a lock before this drives real billing.
- **Virus scanning on client uploads.** Files from outside the firm are
  allow-listed by type and size but not scanned.
- A full client portal. The tokenized request link covers the two steps the
  firm actually waits on; it is deliberately not a login, an account, or a
  view of anything else.
- Everything from the "not migrated yet" list in the schema file: tax
  extensions, billing.
- Document uploads have a first pass now (Files tab on the assignment
  page). Bytes are stored on local disk under `.storage/` via a swappable
  `ObjectStore` (`src/lib/storage.ts`); swap in a Supabase Storage backed
  implementation there when deploying. `.storage/` is disposable.
