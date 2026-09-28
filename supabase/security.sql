-- =============================================================================
-- Supabase lockdown for the workflow app
-- =============================================================================
--
-- Run this in the Supabase SQL editor (or `psql "$DATABASE_URL" -f
-- supabase/security.sql`) AFTER the first `npx prisma db push`, and again
-- after any later push that adds tables. It is idempotent.
--
-- Why this exists: every Supabase project exposes the `public` schema over a
-- REST API (PostgREST) that anyone holding the project's anon/publishable key
-- can call, and that key is designed to be public. A table in `public` without
-- row level security is readable by the whole internet. This is the single
-- most common way Supabase projects leak data.
--
-- This app never uses that API. It talks to Postgres through Prisma as the
-- `postgres` role, and to Storage with the service-role key, both from the
-- server only. So the rule here is simple: the `anon` and `authenticated`
-- roles get NOTHING — no schema access, no table grants, RLS on with no
-- policies, and the file bucket private with a restrictive deny policy. Each
-- layer on its own would stop the leak; they're all here so one mistake later
-- (a dashboard click, a new table) can't reopen it.
--
-- Also do, in the dashboard (these aren't settable from SQL):
--   * Project Settings → Data API: turn the Data API OFF, or remove `public`
--     from "Exposed schemas".
--   * Authentication → disable sign-ups and every provider. The app has its
--     own auth; Supabase Auth users would only be an unused attack surface.
--   * Database → Network restrictions: allow only your app host's IPs.
--   * Database → SSL: "Enforce SSL on incoming connections".
--   * Enable Point-in-Time Recovery (Pro plan) and review who has dashboard
--     access (Organization → Members). Require MFA for every member.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. The file bucket: private, ciphertext only, size-capped.
-- -----------------------------------------------------------------------------
-- The app encrypts every file before upload (src/lib/encryption.ts), so the
-- only content type that should ever land here is application/octet-stream.
-- Anything else means something other than the app is writing to the bucket.
-- 16 MB = the 15 MB upload cap plus encryption overhead.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('workflow-files', 'workflow-files', false, 16 * 1024 * 1024, array['application/octet-stream'])
on conflict (id) do update
  set public             = false,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- RESTRICTIVE, so it is ANDed with every other policy: even if somebody later
-- adds a permissive policy on storage.objects, anon/authenticated still can't
-- touch this bucket. The service role bypasses RLS, which is how the app works.
drop policy if exists "workflow-files: server only" on storage.objects;
create policy "workflow-files: server only"
  on storage.objects
  as restrictive
  for all
  to anon, authenticated
  using (bucket_id <> 'workflow-files')
  with check (bucket_id <> 'workflow-files');

-- -----------------------------------------------------------------------------
-- 2. No API access to the app's tables.
-- -----------------------------------------------------------------------------
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated;
revoke usage               on schema public from anon, authenticated;

-- Tables Prisma creates later (it connects as `postgres`) start with no grants
-- for the API roles either.
alter default privileges for role postgres in schema public revoke all on tables    from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on functions from anon, authenticated;

-- -----------------------------------------------------------------------------
-- 3. Row level security on every table, with no policies.
-- -----------------------------------------------------------------------------
-- RLS with no policies denies every row to anon/authenticated. Prisma is
-- unaffected: `postgres` owns these tables and bypasses RLS. (Deliberately NOT
-- `force row level security`, which would lock the app out too.)
do $$
declare
  t record;
begin
  for t in select schemaname, tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table %I.%I enable row level security', t.schemaname, t.tablename);
  end loop;
end
$$;

-- …and on any table created from now on, automatically.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create or replace function private.enable_rls_on_new_tables()
returns event_trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  obj record;
begin
  for obj in
    select * from pg_event_trigger_ddl_commands()
    where object_type = 'table' and schema_name = 'public'
  loop
    execute format('alter table %s enable row level security', obj.object_identity);
  end loop;
end
$$;

do $$
begin
  drop event trigger if exists workflow_enable_rls_on_new_tables;
  create event trigger workflow_enable_rls_on_new_tables
    on ddl_command_end
    when tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
    execute function private.enable_rls_on_new_tables();
exception when insufficient_privilege then
  raise notice 'Event triggers are not permitted on this project: re-run supabase/security.sql after every prisma db push.';
end
$$;

commit;

-- =============================================================================
-- 4. Verify. Every query below should return ZERO rows except the last, which
--    should show public = false.
-- =============================================================================

-- Tables without RLS:
select schemaname, tablename
from pg_tables
where schemaname = 'public' and not rowsecurity;

-- Anything the API roles can still do to a table:
select grantee, table_name, privilege_type
from information_schema.role_table_grants
where table_schema = 'public' and grantee in ('anon', 'authenticated');

-- Can the API roles even see the schema?
select r.rolname
from pg_roles r
where r.rolname in ('anon', 'authenticated')
  and has_schema_privilege(r.rolname, 'public', 'USAGE');

-- The bucket:
select id, public, file_size_limit, allowed_mime_types
from storage.buckets
where id = 'workflow-files';
