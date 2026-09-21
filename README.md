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
an admin flips a role from the Employees table. Employees see everything except
the Admin Menu.

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
  `src/lib/rate-limit.ts` — throttling for sign-in and password reset.
- `src/lib/email.ts` — the mail transport, reply-token threading, template
  rendering, and webhook signature verification. `src/lib/email-actions.ts`
  holds the server actions; `prisma/email-templates.ts` the built-in messages.
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

## Not built yet

- **Automatic** notifications. Email is wired up and reusable, but nothing
  sends on its own yet: nobody is emailed when they're assigned work and no
  digest goes out when a deadline is close. `sendEmailMessage` in
  `src/lib/email-actions.ts` is the hook for both.
- Time tracking, and any view of how loaded each person is.
- A client-facing surface. `SubtaskKind.CLIENT_TASK` exists but is
  presentational — the checklist has steps that wait on the client
  ("Document Received", "Review done by Client") with no way to ask them.
- Everything from the "not migrated yet" list in the schema file: tax
  extensions, the client portal, billing.
- Document uploads have a first pass now (Files tab on the assignment
  page). Bytes are stored on local disk under `.storage/` via a swappable
  `ObjectStore` (`src/lib/storage.ts`); swap in a Supabase Storage backed
  implementation there when deploying. `.storage/` is disposable.
