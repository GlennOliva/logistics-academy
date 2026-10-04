-- Local validation harness bootstrap.
-- Emulates only the Supabase objects these migrations depend on, so the
-- migrations and their authorization rules can be executed without Docker.
-- This is NOT a Supabase emulator: Auth emails, Storage API, Edge Functions,
-- and hosted RLS internals still require a real Supabase test project.

-- Roles anon, authenticated and service_role are created by the runner script.

grant usage on schema public to anon, authenticated, service_role;

-- Supabase grants these roles broad table privileges by default and each
-- migration narrows them. Reproduce that baseline so a missing explicit revoke
-- fails here instead of silently passing against a hosted project.
alter default privileges in schema public
  grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on functions to anon, authenticated, service_role;
grant all on all tables in schema public to anon, authenticated, service_role;

create schema if not exists auth;
create schema if not exists storage;

create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  confirmed_at timestamptz,
  created_at timestamptz not null default now()
);

create or replace function auth.uid() returns uuid
language sql stable
as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid;
$$;

create table storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false,
  file_size_limit bigint,
  allowed_mime_types text[]
);

create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text not null references storage.buckets(id),
  name text not null,
  owner uuid
);
alter table storage.objects enable row level security;
grant usage on schema storage to anon, authenticated, service_role;
grant select on storage.objects to anon, authenticated, service_role;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
alter default privileges in schema auth grant all on tables to anon, authenticated, service_role;
alter default privileges in schema auth grant all on sequences to anon, authenticated, service_role;

create schema if not exists harness;
grant usage on schema harness to public;

create table harness.results (
  label text primary key,
  passed boolean not null
);
grant insert, update, select on harness.results to public;

create or replace function harness.check(condition boolean, assertion_label text)
returns void
language plpgsql
as $$
begin
  insert into harness.results as r (label, passed) values (assertion_label, condition)
  on conflict (label) do update set passed = excluded.passed;
end;
$$;

create or replace function harness.expect_denied(sql_text text, assertion_label text)
returns void
language plpgsql
as $$
declare
  denied boolean := false;
begin
  begin
    execute sql_text;
  exception when insufficient_privilege then
    denied := true;
  end;
  insert into harness.results as r (label, passed) values (assertion_label, denied)
  on conflict (label) do update set passed = excluded.passed;
end;
$$;

create or replace function harness.expect_error(sql_text text, expect_marker text, assertion_label text)
returns void
language plpgsql
as $$
declare
  failure_message text;
begin
  begin
    execute sql_text;
  exception when others then
    failure_message := sqlerrm;
  end;
  insert into harness.results as r (label, passed)
  values (assertion_label, failure_message is not null and failure_message like '%' || expect_marker || '%')
  on conflict (label) do update set passed = excluded.passed;
end;
$$;

-- RLS hides rows by returning nothing rather than raising, so proving a policy
-- works needs both shapes: no error for read filtering, error for denied writes.
create or replace function harness.expect_no_rows(sql_text text, assertion_label text)
returns void
language plpgsql
as $$
declare
  visible_rows bigint := 0;
begin
  execute sql_text;
  get diagnostics visible_rows = row_count;
  insert into harness.results as r (label, passed) values (assertion_label, visible_rows = 0)
  on conflict (label) do update set passed = excluded.passed;
end;
$$;

-- RLS also filters UPDATE and DELETE by matching zero rows instead of raising,
-- so a refused write has to be proven by the row count, not by an exception.
create or replace function harness.expect_no_change(sql_text text, assertion_label text)
returns void
language plpgsql
as $$
declare
  affected_rows bigint := 0;
begin
  execute sql_text;
  get diagnostics affected_rows = row_count;
  insert into harness.results as r (label, passed) values (assertion_label, affected_rows = 0)
  on conflict (label) do update set passed = excluded.passed;
end;
$$;

grant execute on function harness.check(boolean, text) to public;
grant execute on function harness.expect_denied(text, text) to public;
grant execute on function harness.expect_error(text, text, text) to public;
grant execute on function harness.expect_no_rows(text, text) to public;
grant execute on function harness.expect_no_change(text, text) to public;