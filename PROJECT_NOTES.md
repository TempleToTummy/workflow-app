# Project notes for whoever picks this up next

## Origin
This app is a rebuild of KTAX, a working Oracle APEX application for an
accounting/bookkeeping firm. The schema wasn't designed from scratch, it
was pulled directly from the real APEX export (the app embeds its table
DDL as a hex-encoded install script inside the application export file,
decoding it gave the actual CREATE TABLE statements).

## Real data model, in plain terms
- Client: a business the firm serves.
- Project: not a single task, a recurring WORKFLOW TEMPLATE (e.g. "Monthly
  Bookkeeping"), tied to a recurrence type (monthly/quarterly/annual).
- ProjectSubTask + ProjectTaskMap: the ordered checklist steps for a
  project template.
- ProjectClientMap: turns a project "on" for a specific client.
- ClientActivity: the real unit of work. One row per client, per project,
  per subtask, per accounting period. This is what staff actually check
  off.
- AccountingPeriod: monthly/quarterly/annual date ranges tasks live in.

Real bookkeeping checklist, confirmed from the live app (not invented):
Document Received (10), Data entry (20), Bank Reconciliation (30),
Reviewer Layer 1 (40), Ask My accountant query (42), Reviewer Layer 2 (50),
Report Sent to Client (60), Review done by Client (70), Completed Y/N (80).
Sequence numbers skip on purpose so steps can be inserted later.

## Business rules that used to be Oracle triggers
These lived as PL/SQL triggers in the source app. They're rebuilt as
app-layer logic instead (see src/lib/workflow.ts and src/lib/actions.ts):
- A task can't be marked Done while an earlier task in the same
  client/project/period is still open (sequential completion).
- Once every task in a period is Done, the client's project rolls forward
  to the next accounting period, generating that period's Not Started
  task rows (see maybeRollPeriodForward in actions.ts, triggered from
  updateActivityStatus). One-time projects (no next period) get marked
  completedDate + active:false instead of rolling forward.
- A client can't be deleted while activity or assigned services exist for
  them (deleteClient in actions.ts). Contacts cascade-delete with the
  client since that's a pure ownership relationship; activity and
  assignments don't, since losing that history silently would be wrong.

## What's actually built right now
- Home hub page matching the live app's nav structure.
- Client Project Information: client list + detail page (contacts,
  assigned projects).
- Client Project Activity: the main dashboard, filterable by status,
  client, assignee.
- Assignment detail page: ordered checklist with status controls,
  sequential completion enforced.
- Client create/edit forms (`/clients/new`, `/clients/[id]/edit`) covering
  every field on the Client model, plus a Services section: check which
  recurring projects (Bookkeeping, Sales Tax, tax returns, license
  renewals, etc.) apply to that client, which assigns the project and
  generates its checklist rows for the current period. See
  src/components/client-form.tsx.
- The project catalog (prisma/seed.ts) now has all 13 real services from
  the live app's nav, with real checklist steps and sequence numbers
  pulled from screenshots of the source app's Project pages: 1099 Form,
  Annual Report, Bookkeeping, Business Tax Return, Individual Tax Return,
  Liquor License Renewal, Sales Tax, Tax Return Extension, Tobacco License
  Renewal. Four services (Monthly Financial Report, New Business
  Registration, Payroll, Quarterly Financial Report) exist as project
  templates but with zero checklist steps, their real checklists were
  never visible in the source screenshots, so nothing was invented for
  them, they're disabled in the Services picker until someone supplies
  real steps.
- RecurringType gained a fourth value, ONE_TIME (for New Business
  Registration, a non-recurring service). src/lib/periods.ts derives the
  "current" AccountingPeriod for any cadence (monthly/quarterly/annual/
  one-time) from today's date and creates it on demand the first time a
  client is assigned to that cadence, this is what lets the client form
  assign a service without asking the user to pick a period by hand.
  It also has nextPeriodName (cadence-aware "what comes after this
  period") and getRecurring (fetch-or-create the singleton
  ProjectRecurring row for a cadence), both used by the rollover logic
  and the admin Project/AccountingPeriod forms.
- All 8 Reports pages and all 7 Admin Menu pages are built (see below),
  replacing the old ComingSoon placeholder (removed, nothing references
  it anymore).
- Reports (read-only, src/app/reports/*): Project Activity List (every
  task row, grouped by client+period), Projects Status Summary
  (per-service progress bars), Project Activity Status (per-service,
  each client's status), Client Activity Matrix (client x service status
  grid), Project Summary Matrix (service x status count grid), Project
  Task Compare (checklists side by side by step position), Project
  Assigned to Client (flat ProjectClientMap list), Client Information
  List (flat client field dump).
- Admin (src/app/admin/*), full CRUD: Projects (the service catalog: name,
  description, cadence), Projects Task (the ProjectSubTask master list),
  Projects Task Map (which subtasks belong to which project, in what
  order, this is where the 4 no-checklist services from above get real
  steps whenever someone has them), Admin Client Activity (every
  ClientActivity row, status/assignee/notes editable inline, no
  sequential-completion bypass), Accounting Period Information
  (periods are normally auto-created, this is a manual add), Employees
  (+ inline Employee Type creation), Corporate & Business Type (both
  lookups on one page).
- FilterBar (src/components/filter-bar.tsx) had a bug: it hardcoded
  navigation to "/" on any filter change instead of the current page,
  so filtering broke everywhere except the root dashboard. Fixed to use
  usePathname() before Admin Client Activity started reusing it.
- The assignment detail page (src/app/assignments/[clientId]/[projectId])
  is now a tabbed workspace, not just a checklist:
  - List tab: each ClientActivity step expands into an ad-hoc nested
    checklist (ActivitySubtask). A subtask is either a TEAM_TASK or a
    CLIENT_TASK (a request for the client to provide something); the kind
    is presentational only for now. Subtasks are advisory — they do NOT
    gate the parent step's status or the sequential-completion rule in
    src/lib/workflow.ts; the parent just shows a done/total count. The
    per-step assignee is editable inline here too.
  - Assignees panel (right rail): bulk-assign one employee across every
    unassigned step in the current period, or a hand-picked subset. Runs
    on ClientActivity.assigneeId via updateMany — no new model, still one
    assignee per step.
  - Files tab: Document model + a swappable ObjectStore (src/lib/storage.ts).
    LocalObjectStore writes bytes under ./.storage/<bucket>/<key> (gitignored,
    disposable) to simulate a cloud bucket; bucket + storageKey on the row
    are the object address, so moving to Supabase Storage is a one-file
    swap with no schema change. Downloads stream through
    src/app/api/documents/[id]/route.ts. Uploads go through a Server Action;
    next.config.ts raises serverActions.bodySizeLimit to 15mb for it.
  - Notes tab: AssignmentNote, a running list of timestamped notes per
    engagement (client + project), not period-scoped.
  New server actions live in the existing src/lib/actions.ts under the
  "Assignment detail" section. The client components on this page call
  router.refresh() after each awaited action and drive optimistic UI with
  useOptimistic (checklist) — revalidatePath alone wasn't repainting the
  page for imperatively-invoked (non-form) actions, so sibling panels
  (e.g. the Assignees roster) went stale until a manual reload.
- Authentication was added (the schema header's "auth belongs to Supabase
  Auth" note is now out of date — we went self-contained instead, since the
  app still runs on local SQLite with no external services):
  - Two roles, ADMIN and EMPLOYEE (Role enum on Employee). Employee.email is
    now required (the login identity); passwordHash null = invite-pending.
    Session model backs an httpOnly wf_session cookie.
  - Passwords: scrypt via src/lib/password.ts (no deps, importable by
    prisma/seed.ts since it has no next/* imports). Sessions + guards in
    src/lib/auth.ts (getCurrentUser / requireUser / requireAdmin).
  - Enforcement is two layers: src/proxy.ts (Next 16 renamed middleware →
    proxy; MUST live at src/proxy.ts, not repo root, because the app uses a
    src/ dir) does a cheap cookie/path gate; requireUser()/requireAdmin() do
    the real check at the top of every page, in src/app/admin/layout.tsx and
    src/app/reports/layout.tsx, and as the first line of every server action
    in src/lib/actions.ts (they're reachable by direct POST).
  - New user flow: admin creates an Employee (createEmployee issues an
    inviteToken, 7-day expiry) → Employees page shows a Copy link button for
    /invite/<token> → invitee sets a password (acceptInvite) and gets a
    session. regenerateInvite re-arms an expired link; revokeAccess kills
    sessions + clears the password without deleting history. setEmployeeRole
    flips ADMIN/EMPLOYEE. assertNotLastAdmin() blocks locking everyone out.
  - Seeded admin: admin@workflow.test / admin1234 (ADMIN_PASSWORD in
    prisma/seed.ts). The other seeded employees are invite-pending.
  - Auth actions are in src/lib/auth-actions.ts (login/logout/acceptInvite),
    separate from the main actions.ts.
- Top-level nav gained Projects and Tasks alongside Dashboard and Clients:
  - /projects (+ /projects/[projectId]): per-service rollup — cadence,
    step count, # active clients, live progress this period; the detail
    page lists that project's active engagements. Separate from
    /admin/projects, which is still the catalog CRUD.
  - /tasks: every ClientActivity in an active assignment's current period,
    one row per step, reusing FilterBar (status/client/assignee).
- Project builder (FinancialCents-style, any signed-in user, not admin-only):
  - /projects/new creates a project (name, description, cadence) via
    createOwnProject and lands on /projects/[projectId].
  - /projects/[projectId] now has the checklist builder
    (src/components/project-checklist-builder.tsx) above the clients table:
    add a task, click to rename, × to remove, drag the handle (or arrow keys
    on it) to reorder. Dragging uses pointer events, no library: as the
    dragged row crosses a neighbour's midpoint the neighbour slides out of
    the way, so dragging #3 up between #1 and #2 pushes #2 into slot 3.
  - Each task is a ProjectSubTask + ProjectTaskMap on that project, so
    assignment, rollover, admin pages and reports all work unchanged. The
    actions live in src/lib/actions.ts under "Project builder":
    addChecklistTask / renameChecklistTask / removeChecklistTask /
    reorderChecklist. Reorder renumbers to 10, 20, 30… and rejects a stale
    order (set mismatch) rather than clobbering a concurrent add/remove.
  - Guards: a step with ClientActivity rows shows "In use" and can't be
    removed; renaming a step shared with other projects is refused (do it
    from Admin → Projects Task). Removing a step that nothing else
    references also deletes the orphan ProjectSubTask from the master list.
  - Reordering the template only affects rows generated from then on (new
    assignments, next period). Existing ClientActivity taskSeqNo is left
    alone on purpose — changing it could put a Done step after an open one
    and break the sequential-completion rule.
- Adding a client to a project after creation: the client detail page's
  "Projects" card (was "Project Client Map") has an Add-to-project picker
  (src/components/assign-project-panel.tsx) listing every project the
  client isn't on yet; projects with no tasks are shown but disabled. It
  calls the same assignProjectToClient action the client form uses, so the
  current period's checklist rows are generated identically.
- Dashboard due-summary cards (FinancialCents-style): Due Today / Due This
  Week / Due Next Week / Overdue above the table
  (src/components/due-summary-cards.tsx). Buckets come from dueBucket() in
  src/lib/dates.ts: weeks run Mon–Sun, "this week" = today through Sunday,
  "next week" = the following Mon–Sun, Done work and no-due-date work are
  excluded. Clicking a card sets ?due=<bucket> (click again to clear); the
  other filters are preserved and Clear filters resets it too. Counts
  respect the status/client/assignee filters but not the due filter, so
  all four numbers stay readable while one is active.
- Dashboard search + filter chips (src/components/filter-bar.tsx, rewritten):
  a search box (matches client name or project name, debounced, uses
  router.replace so typing doesn't spam history) and pill-style chips with
  custom dropdown menus — Due Date, Accounting Period, Assignee, Client,
  Project, Status. Everything is URL-driven (?q, ?due, ?period, ?projectId,
  ?assigneeId, ?clientId, ?status) so any view is linkable, and the due
  cards preserve whatever else is set. Pages opt into the extra chips via
  props (search / due / projects / periods); /tasks and Admin Client
  Activity still pass only clients + employees and get the original
  Assignee / Client / Status trio. Chips FinancialCents has that we don't
  (Tags, Client Groups, Show Current Assignee, saved views) were left out
  on purpose — nothing behind them yet.
- Contacts (CorpContact) now have a UI: a Contacts section on the client
  create/edit form (draft rows, reconciled on save: new → createContact,
  changed → updateContact, removed → deleteContact, blank rows ignored) and
  an inline ContactManager card on the client detail page
  (src/components/contact-manager.tsx) with add / edit / remove. Actions in
  src/lib/actions.ts under "Client contacts". A contact needs at least a
  name, email, or mobile. ssnEncrypted is still deliberately not exposed
  anywhere (see below).
- Completed periods are first-class now (FinancialCents "project per
  period" model), with NO schema change — rollover already left the old
  period's ClientActivity rows in place, the UI just never showed them:
  - The dashboard (src/app/page.tsx) renders one row per client + project
    + period (grouped from ClientActivity, plus an empty row for a current
    period with no tasks yet), not one per ProjectClientMap. A row is
    "completed" when every task in it is Done. View tabs (?view=all|open|
    completed): All shows open rows sorted by due date, then a "Completed ·
    N" divider and the completed rows (most recent first); Open and
    Completed show one side. Inactive assignments (finished one-time
    projects) are included so they land under Completed. Each project cell
    shows the period as a pill.
  - The assignment page takes ?period=<name>; default is the current
    period. Unknown periods 404. A "Periods" pill row lists every period the
    engagement has had (check mark = done, "current" tag), and a green
    banner marks a completed period with a link to the current one.
    AssignmentTabs carries ?period through the List/Files/Notes links.
  - Files are scoped to the period being viewed: Document.periodName
    already existed and uploads already stamped it, so the Files tab just
    filters on it. A rolled-forward period starts with an empty Files tab;
    the old period keeps its own. Legacy documents with periodName null show
    on the current period only. Notes are NOT period-scoped (AssignmentNote
    has no periodName) — they remain the engagement's running log; add a
    periodName column if that ever needs to change.
  - The client detail page has a Files card listing every document for the
    client grouped project → period (newest period first), with download
    links (/api/documents/[id]) and an "Open project →" link that deep-links
    to that period's Files tab.
  - Task rows in a completed period are still editable (no read-only mode);
    updateActivityStatus's rollover guard ignores non-current periods, so
    poking history can't trigger a second rollover.
- Employee visibility scope: EMPLOYEE-role users see only work assigned to
  them; ADMIN sees the firm. assigneeScope(user) in src/lib/auth.ts returns
  the employee id to scope by (null for admins) and every operational page
  applies it:
  - Dashboard: only client/project/period rows with at least one step
    assigned to them. Tasks: only their own steps (assignee chip hidden,
    filter pinned to them). Clients and Projects lists: only ones they have
    a task on. The Client chip's option list is scoped too, so names don't
    leak through the dropdown.
  - Detail pages (client, project, assignment) redirect away when the
    employee has no task there; the assignment gate is engagement-level
    (any period), so past periods they worked stay reachable. The project
    page's client table is filtered to their clients.
  - Reports are admin-only now (src/app/reports/layout.tsx uses
    requireAdmin; the sidebar hides the Reports group for employees) —
    every report is a firm-wide view and would leak the rest.
  - Not scoped: the per-step assignee dropdown and Assignees panel on the
    assignment page still let an employee reassign steps they can see, and
    server actions still only check requireUser(). Tighten those if "can
    see" needs to become "can't touch".
- The client page's Add-to-project picker was reworked from a native
  <select> to a toggle button that opens a searchable card grid (name,
  cadence, step count, one-click Add); projects with no tasks show as
  dashed/disabled with a "set up" link to the project page.

- Due dates are real now (they used to be the accounting period's end date and
  nothing else, so every monthly client shared one deadline and every step
  inside an engagement shared it too):
  - Three layers, each falling back to the one above it. Project.dueOffsetDays
    is the service's rule ("N days after the period ends"; 0 = last day of the
    period, the old behaviour). ProjectClientMap.dueOffsetDays overrides it for
    one client (an extension on file, a negotiated turnaround).
    ProjectTaskMap.dueOffsetDays is a per-step internal milestone relative to
    the engagement's deadline — negative is earlier ("reviewer layer 2 done a
    week before we file").
  - The resolved date is materialized onto ClientActivity.dueDate when the row
    is generated, so the dashboard sorts and filters in the database instead of
    recomputing per render. Changing any rule calls recomputeDueDates() in
    src/lib/actions.ts, which rewrites the affected rows in batched updateManys
    (one per distinct date, not one per row).
  - ClientActivity.dueDateOverridden is the escape hatch: a date typed onto one
    task by hand. recomputeDueDates never touches those rows, so a rule change
    can't silently undo an extension someone recorded. Clearing the date hands
    the row back to the rules.
  - The math is all in src/lib/due-dates.ts (pure, no next/* imports, so
    prisma/backfill-due-dates.ts can reuse it). resolveStepDueDates() is the
    single entry point — row generation and recompute both call it, which is
    what stops the two from drifting.
  - UI: a Due date rule card with cadence-aware presets on /projects/[id]
    (src/components/project-due-rule.tsx); a days field on the admin project
    form; a per-step offset chip in the checklist builder; a Deadline panel on
    the assignment page with the per-client override
    (src/components/assignment-due-panel.tsx); and a click-to-edit date on each
    checklist step. Due columns were added to /projects and /admin/projects.
  - Dashboard/Projects rows show the *next thing owed* — the earliest open
    step's date, falling back to the last date once everything is done. Steps
    can now legitimately be due on different days within one period, so "the
    row's due date" needed a definition.
  - Seeded rules (prisma/seed.ts DUE_RULES) cover only federal statutory
    deadlines, which are facts: 1099 Jan 31 (31), business return Mar 15 (74),
    individual return Apr 15 (105), extension Apr 15 (105). Everything else is
    left at 0 for the firm to set on the project page — inventing a deadline
    would have been worse than leaving it visibly unset, same reasoning as the
    four services whose checklists were never confirmed.
  - prisma/backfill-due-dates.ts is the one-off for a database that predates
    this: applies the statutory rules and dates every existing task row.
    Idempotent, skips overridden rows. Already run against prisma/dev.db.
- Work generation runs on a schedule now. This was the bigger of the two
  problems: period rollover only ever happened inside updateActivityStatus, as
  a side effect of someone ticking the last task of a period done. An
  engagement that fell behind therefore stopped producing work entirely and
  nobody was told — "what's overdue" was unanswerable because the overdue work
  had never been created.
  - src/lib/scheduler.ts is the job. generatePeriods() walks every active
    engagement from the period it's parked in up to the period today falls in,
    opening each one along the way, whether or not the previous one was
    finished. An engagement three months behind ends up with three open periods
    on the board, which is the truth.
  - openPeriodForAssignment() is the single row generator. assignProjectToClient
    and maybeRollPeriodForward were rewritten to call it too, so all three
    paths produce identical rows with identical due dates. It's idempotent —
    SQLite has no createMany skipDuplicates, so it diffs against existing rows
    explicitly, which also repairs a half-generated period.
  - Guard rails: MAX_CATCHUP_PERIODS (60) stops a runaway walk on bad data,
    unparseable period names are reported as a skip rather than spinning the
    loop, and one-time projects are swept for finished-but-still-open
    engagements (the admin client-activity page edits statuses without going
    through the completion path, so that hole was real).
  - Every run writes a SchedulerRun row (trigger, status, counts, notes,
    duration), so the job's history is visible in the app instead of in logs.
  - Three ways in, one code path: POST/GET /api/cron/generate-periods with
    Authorization: Bearer $CRON_SECRET (vercel.json has a daily 06:00 UTC cron
    entry); the Run now button on /admin/scheduler; and ensurePeriodsCurrent(),
    a lazy catch-up the dashboard awaits which fires only when no successful run
    has happened in 6 hours. The lazy path exists because this app ships on
    local SQLite with no scheduler attached — without it the feature would be
    documentation. PERIOD_AUTOGEN=off disables it.
  - src/proxy.ts gained a MACHINE_PREFIXES list (/api/cron) exempt from the
    cookie gate — a scheduler has no session, so it was being 307'd to /login.
    Those routes authenticate themselves in the handler (bearer token, or an
    admin session for the button).
  - /admin/scheduler (Admin Menu → Work Generation) is the operational view:
    last-run freshness with a stale warning past 24h, run history, and a list of
    engagements still parked behind the current period with the reason (almost
    always "this service has no checklist steps yet").

- Email is integrated, as a top-level Email section in the sidebar (not a tab
  on the assignment page — the firm-wide roll-up was the chosen shape):
  - src/lib/email.ts is the whole library and has no next/* imports, so
    scripts/test-email.ts can exercise it directly (24 assertions, runs on tsx,
    no test framework). Transport is swappable exactly like ObjectStore in
    storage.ts: LogTransport (default, records and delivers nothing) and
    ResendTransport (fetch to api.resend.com, no new dependency), chosen by
    whether RESEND_API_KEY is set.
  - LogTransport reports "logged", NOT "sent", and EmailStatus has a LOGGED
    member that renders as "Not sent" with an explanation. Telling someone a
    message went out when no provider exists would be worse than the missing
    feature, so the distinction is carried all the way to the badge.
  - Threading is by reply token, not subject line. Every outbound message gets
    a random replyToken; its Reply-To is <prefix>+<token>@EMAIL_INBOUND_DOMAIN.
    The inbound webhook recovers the token from the To: address and threads the
    reply onto the same threadKey. threadKey is
    "eng:<clientId>:<projectId>:<period>" when there's an engagement, else
    "client:<id>", so a conversation is scoped to the period it's about.
  - Inbound resolution is three-tier: reply token → sender address matched
    against CorpContact.email and Client.email → stored unattached under an
    "Unmatched" tab. Nothing is ever dropped. That tab hides itself when empty.
  - POST /api/email/inbound verifies Svix-style headers (svix-id /
    svix-timestamp / svix-signature, HMAC-SHA256 over "<id>.<ts>.<body>",
    base64, whsec_ prefix stripped — what Resend sends), a plain
    x-webhook-signature HMAC, or a bearer token, and rejects anything older
    than five minutes. It refuses everything when EMAIL_INBOUND_SECRET is
    unset. The signature is computed over the raw body, so the handler reads
    request.text() and parses JSON only after verifying.
  - Resend's email.received webhook is METADATA ONLY (sender, recipients,
    subject, attachment list, email_id) — the body is NOT in the payload. This
    was found by checking Resend's docs after the first pass shipped assuming
    an inline body, which would have stored every inbound reply blank. The
    route now detects an empty body with an email_id and fetches it via
    GET https://api.resend.com/emails/receiving/{id} (same RESEND_API_KEY as
    sending). A failed fetch stores the message anyway with an explanatory body
    rather than dropping it or leaving it silently empty.
  - The parser still reads the union of common field spellings (from/From/
    sender, text/TextBody/body_plain, …) so providers that DO inline the body
    work without a second call. Confirm field names against whichever provider
    is actually used.
  - src/proxy.ts MACHINE_PREFIXES gained /api/email/inbound alongside
    /api/cron: a mail provider has no session cookie and was being 307'd to
    /login.
  - Templates live in the DB (EmailTemplate) and are seeded from
    prisma/email-templates.ts. The seven built-ins map to checklist steps that
    genuinely require writing to a client ("Document Received", "Report Sent to
    Client", "Review done by Client", "Send form 8879 for signature") rather
    than a generic set. prisma/seed-email-templates.ts loads them into an
    existing database without wiping anything and skips keys already present,
    so edited wording survives a re-run.
  - Placeholders resolve against live data — open task count, the next open
    step, the engagement's due date from the due-date engine — via
    renderTemplateForEngagement, one server round trip. The template editor
    flags a placeholder that isn't a known variable, since a typo renders as an
    empty string in a message a client reads.
  - Employee scoping is enforced on both sides: messageScope() in email-data.ts
    limits an employee to mail about engagements they have a task on (and their
    own sent mail), and assertCanEmailClient() blocks sending on behalf of a
    client they don't work with. The thread page applies the scope to the
    lookup itself, so an unauthorised id 404s rather than leaking content.
  - FilterBar gained a `statuses` prop (array to override the options, null to
    hide the chip). It previously hardcoded the ClientActivity statuses, which
    are meaningless on the Email page.
  - Nothing sends automatically. sendEmailMessage is the hook for assignment
    notifications, deadline digests and invite emails, but wiring those up is a
    separate decision — the app should not start mailing clients as a side
    effect of adding an integration.

- Password reset, audit trail and default assignees (the remaining Tier 1 gaps
  from the earlier review):
  - Reset tokens are stored as a SHA-256 hash (Employee.resetTokenHash),
    unlike inviteToken which predates this and is still raw — that should be
    migrated the same way. Plain SHA-256 is deliberate, not an oversight:
    the input is already 256 bits of randomness, so there is nothing to brute
    force and a KDF would only cost time on every lookup.
  - requestPasswordReset answers identically whether or not the account
    exists. The only externally visible difference is timing, and the work
    either way is one indexed lookup. The throttle message is safe to show
    because it reveals nothing about the account.
  - Redeeming a reset deletes every session for that employee. If the reset
    happened because the account was compromised, leaving the attacker's
    session alive would defeat the point. It also clears any outstanding
    invite token, since the account now has a password.
  - src/lib/rate-limit.ts is a fixed-window in-memory limiter covering login,
    reset requests and reset redemption. In-memory is the honest fit for a
    single-process SQLite app, but it resets on restart and does NOT coordinate
    across instances — deploying more than one instance silently multiplies
    every limit by the instance count. Move it to the DB or a shared cache
    first.
  - src/lib/system-email.ts sends the reset mail. It is deliberately NOT a
    "use server" module: its one caller is an unauthenticated action, so
    exposing it as a server action would hand anyone an open relay sending
    arbitrary text from the firm's address.
  - Because mail is in log-only mode, the reset email is recorded and not
    delivered. Admin → Employees therefore has a "Reset password" button that
    mints a link to hand over, mirroring the invite flow. It is admin-only and
    audited: minting one is a way to take over an account.
  - src/proxy.ts PUBLIC_PREFIXES gained /forgot-password and /reset-password.
  - AuditEvent has NO foreign keys, on purpose. History has to outlive what it
    describes — deleting a client must not erase the record of what was done to
    it — so ids are plain strings and every row carries denormalized
    actorLabel/contextLabel. This is why the client-deleted event is recorded
    AFTER the delete and still resolves.
  - recordAudit never throws. A failure to write history is logged and
    swallowed; refusing to mark a task done because an audit insert failed
    would be the worse outcome. recordAuditMany exists so a bulk reassignment
    leaves one row per step rather than one vague summary — bulk paths read
    the rows BEFORE updateMany, since afterwards the old values are gone.
  - ClientActivity.completedAt/completedById is a real completion stamp.
    updatedAt could not serve: any later edit to notes or assignee clobbered
    it. Re-opening a step clears the stamp rather than leaving a withdrawn
    sign-off on the record. Shown inline on each done step.
  - /activity (was a redirect to /) is the log, admin-only for the same reason
    Reports are: it is firm-wide and an employee scoped to their own clients
    would see everything through it. Per-engagement history is a panel on the
    assignment page instead, where the existing visibility rules already apply.
  - AuditFilters is its own component rather than a FilterBar variant: FilterBar
    is built around the work params (status/due/period) and the log filters on
    action/actor/client, a different axis entirely.
  - Default assignees resolve step-owner-wins, engagement-owner-fills-the-rest.
    The reasoning is in src/lib/default-assignees.ts: a step owner expresses a
    role, so a client owner must not be able to silently take over a reviewer
    sign-off. Verified by scripts/test-workflow-rules.ts.
  - Defaults are applied at generation time inside openPeriodForAssignment, so
    all three generation paths (assign, rollover, scheduler) get them. Changing
    a default is NOT retroactive; applyDefaultAssignees is the explicit way to
    push it onto an existing period and only fills blanks — it never reassigns
    work someone has already picked up.
  - Employee relations for the new assignee fields use onDelete: SetNull, so
    deleting an employee clears defaults rather than failing or cascading.

## Known gaps / things to be careful about
- CorpContact.ssnEncrypted is a placeholder field name only: real SSNs must
  never go in there until actual encryption is implemented, so the contact
  forms deliberately don't expose it.
- The source app had a plaintext EMPLOYEES.EMPLOYEE_PASSWORD column. It
  was deliberately NOT carried over. Auth should be handled by Supabase
  Auth, not a hand-rolled password table.
- CRON_SECRET currently sits in .env with an obvious throwaway value, and .env
  is NOT gitignored (only .env*.local is). Set a real secret as a deployment
  environment variable; do not promote the one in the file.
- recomputeDueDates rewrites dates on historical periods too, not just open
  ones. That's deliberate — the date is derived data and a mix of old and new
  rules across periods would be harder to explain than a uniform recompute —
  but it does mean editing a service's rule changes what a closed period says
  it was due. Rows dated by hand are exempt.
- Reordering or adding a checklist step still only affects rows generated from
  then on (unchanged). A step added to a project mid-period does not appear in
  already-generated periods, including ones the scheduler opens later for other
  engagements.
- The rate limiter is per-process and in-memory (see above) — it is not safe
  for a multi-instance deployment as written.
- Audit coverage is broad but not total: contacts, documents, notes, email
  sends, lookups (corporation/business/employee types) and the project
  builder's add/rename/remove/reorder do NOT record events yet. recordAudit is
  a one-liner, so extend it where it matters rather than assuming the log is
  complete.
- There is no retention or archival policy for AuditEvent. It grows without
  bound and /activity pages at 100 rows; a firm-sized dataset will eventually
  want pruning or a date-range filter.
- Email attachments are not implemented. The Files tab holds documents and the
  templates talk about "attached" reports, but nothing is actually attached to
  an outgoing message yet — Document rows would need to be read from the
  ObjectStore and encoded into the provider payload.
- Delivery/bounce webhooks are not wired. EmailStatus has DELIVERED and
  BOUNCED, and the UI renders them, but only the inbound-mail webhook exists —
  nothing currently moves a message out of SENT.
- EMAIL_INBOUND_SECRET and the other mail settings are in .env, which is NOT
  gitignored (only .env*.local is). Same caveat as CRON_SECRET: set real values
  as deployment environment variables.
- The scheduler has no locking beyond the in-process `inFlight` guard in
  ensurePeriodsCurrent. Two instances running the job at the same moment is
  safe (every write is a diff against existing rows) but would both log a run.

## Deployment target
Currently runs on local SQLite for easy setup. To move to Supabase: change
the datasource provider in prisma/schema.prisma from "sqlite" to
"postgresql", and put the Supabase connection string in .env as
DATABASE_URL.