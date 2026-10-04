alter table public.email_outbox
  add column locked_at timestamptz,
  add column lock_token uuid,
  add column lease_until timestamptz,
  add column updated_at timestamptz not null default now(),
  add column provider_message_id text,
  add column failed_at timestamptz;

create table public.email_delivery_events (
  id bigint generated always as identity primary key,
  outbox_id uuid not null references public.email_outbox(id) on delete cascade,
  event_type text not null check (event_type in ('claimed', 'sent', 'retry_scheduled', 'failed')),
  attempt integer not null,
  provider_message_id text,
  error text,
  created_at timestamptz not null default now()
);
create index email_delivery_events_outbox_idx on public.email_delivery_events(outbox_id, created_at);

create or replace function public.claim_email_outbox(worker_name text, batch_size integer default 10)
returns table (
  id uuid,
  idempotency_key text,
  template text,
  recipient_user_id uuid,
  payload jsonb,
  attempt integer,
  lock_token uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if char_length(trim(worker_name)) < 3 then raise exception 'A worker name is required'; end if;
  if batch_size < 1 or batch_size > 50 then raise exception 'Batch size must be between 1 and 50'; end if;

  return query
  with candidates as (
    select eo.id
    from public.email_outbox eo
    where (eo.status = 'queued' and eo.next_attempt_at <= now())
       or (eo.status = 'sending' and eo.lease_until < now())
    order by eo.next_attempt_at, eo.created_at
    limit batch_size
    for update skip locked
  ), claimed as (
    update public.email_outbox eo
    set status = 'sending', attempts = eo.attempts + 1, locked_at = now(),
        lock_token = gen_random_uuid(), lease_until = now() + interval '5 minutes', updated_at = now()
    from candidates c
    where eo.id = c.id
    returning eo.*
  ), events as (
    insert into public.email_delivery_events (outbox_id, event_type, attempt)
    select c.id, 'claimed', c.attempts from claimed c
  )
  select c.id, c.idempotency_key, c.template, c.recipient_user_id,
         c.payload, c.attempts, c.lock_token
  from claimed c;
end;
$$;

create or replace function public.mark_email_sent(
  target_outbox uuid,
  worker_token uuid,
  provider_id text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare current_attempt integer;
begin
  update public.email_outbox
  set status = 'sent', sent_at = now(), provider_message_id = nullif(trim(provider_id), ''),
      lock_token = null, lease_until = null, last_error = null, updated_at = now()
  where id = target_outbox and status = 'sending' and lock_token = worker_token
  returning attempts into current_attempt;
  if not found then raise exception 'Email lease is invalid or expired'; end if;

  insert into public.email_delivery_events (outbox_id, event_type, attempt, provider_message_id)
  values (target_outbox, 'sent', current_attempt, nullif(trim(provider_id), ''));
end;
$$;

create or replace function public.mark_email_failed(
  target_outbox uuid,
  worker_token uuid,
  failure text,
  retryable boolean
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare current_attempt integer;
declare terminal boolean;
begin
  select attempts into current_attempt
  from public.email_outbox
  where id = target_outbox and status = 'sending' and lock_token = worker_token
  for update;
  if not found then raise exception 'Email lease is invalid or expired'; end if;

  terminal := not retryable or current_attempt >= 5;
  update public.email_outbox
  set status = case when terminal then 'failed'::public.email_status else 'queued'::public.email_status end,
      next_attempt_at = case when terminal then next_attempt_at else now() + make_interval(mins => least(60, (2 ^ current_attempt)::integer)) end,
      last_error = left(coalesce(nullif(trim(failure), ''), 'Provider request failed'), 500),
      failed_at = case when terminal then now() else null end,
      lock_token = null, lease_until = null, updated_at = now()
  where id = target_outbox;

  insert into public.email_delivery_events (outbox_id, event_type, attempt, error)
  values (
    target_outbox, case when terminal then 'failed' else 'retry_scheduled' end,
    current_attempt, left(coalesce(nullif(trim(failure), ''), 'Provider request failed'), 500)
  );
end;
$$;

alter table public.email_delivery_events enable row level security;
create policy email_delivery_events_admin_read on public.email_delivery_events
  for select to authenticated using (public.is_admin());
revoke all on public.email_delivery_events from anon, authenticated;
grant select on public.email_delivery_events to authenticated;
revoke all on function public.claim_email_outbox(text, integer) from public, anon, authenticated;
revoke all on function public.mark_email_sent(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.mark_email_failed(uuid, uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.claim_email_outbox(text, integer) to service_role;
grant execute on function public.mark_email_sent(uuid, uuid, text) to service_role;
grant execute on function public.mark_email_failed(uuid, uuid, text, boolean) to service_role;
