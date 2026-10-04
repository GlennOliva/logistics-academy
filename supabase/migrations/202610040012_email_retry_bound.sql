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

  with exhausted as (
    update public.email_outbox eo
    set status = 'failed', failed_at = now(), lock_token = null, lease_until = null,
        last_error = coalesce(eo.last_error, 'Worker lease expired after the final attempt'), updated_at = now()
    where eo.status = 'sending' and eo.lease_until < now() and eo.attempts >= 5
    returning eo.id, eo.attempts, eo.last_error
  )
  insert into public.email_delivery_events (outbox_id, event_type, attempt, error)
  select exhausted.id, 'failed', exhausted.attempts, exhausted.last_error from exhausted;

  return query
  with candidates as (
    select eo.id
    from public.email_outbox eo
    where eo.attempts < 5
      and ((eo.status = 'queued' and eo.next_attempt_at <= now())
        or (eo.status = 'sending' and eo.lease_until < now()))
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

revoke all on function public.claim_email_outbox(text, integer) from public, anon, authenticated;
grant execute on function public.claim_email_outbox(text, integer) to service_role;
