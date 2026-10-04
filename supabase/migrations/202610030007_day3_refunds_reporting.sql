create type public.refund_request_status as enum ('submitted', 'approved', 'denied', 'completed', 'cancelled');

create table public.refund_requests (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.payment_submissions(id),
  status public.refund_request_status not null default 'submitted',
  request_channel text not null,
  reason text not null check (char_length(trim(reason)) >= 3),
  requested_at timestamptz not null default now(),
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  review_reason text,
  unique (submission_id)
);

create table public.refunds (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique references public.refund_requests(id),
  submission_id uuid not null unique references public.payment_submissions(id),
  amount_centavos integer not null check (amount_centavos > 0),
  currency text not null check (currency = 'PHP'),
  external_reference text not null unique check (char_length(trim(external_reference)) >= 3),
  refunded_at timestamptz not null,
  recorded_by uuid not null references auth.users(id),
  access_revoked boolean not null default false,
  certificate_decision text not null default 'retained' check (certificate_decision = 'retained'),
  created_at timestamptz not null default now()
);
create index refunds_refunded_at_idx on public.refunds(refunded_at);

create or replace function public.record_completed_refund(
  target_submission uuid,
  actual_amount_centavos integer,
  external_completion_reference text,
  completion_time timestamptz,
  reason text,
  revoke_access boolean default false
)
returns public.refunds
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  submission public.payment_submissions;
  target_order public.orders;
  target_enrollment public.enrollments;
  request_record public.refund_requests;
  existing_refund public.refunds;
  result public.refunds;
  access_was_revoked boolean := false;
begin
  if not public.is_admin(actor) then raise exception 'Administrator role required'; end if;
  if char_length(trim(reason)) < 3 then raise exception 'A substantive reason is required'; end if;
  if char_length(trim(external_completion_reference)) < 3 then raise exception 'An external completion reference is required'; end if;
  if completion_time is null or completion_time > now() + interval '5 minutes' then raise exception 'A valid external completion time is required'; end if;

  select * into submission from public.payment_submissions where id = target_submission for update;
  if not found then raise exception 'Payment submission not found'; end if;

  select * into existing_refund from public.refunds where submission_id = target_submission;
  if found then
    if existing_refund.amount_centavos = actual_amount_centavos
      and existing_refund.external_reference = trim(external_completion_reference) then return existing_refund;
    end if;
    raise exception 'This payment already has a different completed refund';
  end if;

  if submission.status <> 'approved' then raise exception 'Only an approved payment can be reconciled as refunded'; end if;
  if actual_amount_centavos <> submission.submitted_amount_centavos then raise exception 'Only a verified full refund can be reconciled'; end if;

  select * into target_order from public.orders where id = submission.order_id for update;
  select * into target_enrollment
  from public.enrollments where user_id = target_order.user_id and course_id = target_order.course_id for update;

  insert into public.refund_requests (
    submission_id, status, request_channel, reason, reviewed_by, reviewed_at, review_reason
  ) values (
    submission.id, 'completed', 'external_reconciliation', trim(reason), actor, now(),
    'Funds were confirmed returned outside the platform before reconciliation.'
  )
  returning * into request_record;

  if revoke_access and target_enrollment.id is not null then
    update public.enrollment_grants
    set active = false
    where enrollment_id = target_enrollment.id and source_type = 'payment' and source_id = submission.id;

    if not exists (
      select 1 from public.enrollment_grants
      where enrollment_id = target_enrollment.id and active
    ) then
      update public.enrollments set status = 'revoked', updated_at = now() where id = target_enrollment.id;
      access_was_revoked := true;
    end if;
  end if;

  insert into public.refunds (
    request_id, submission_id, amount_centavos, currency, external_reference,
    refunded_at, recorded_by, access_revoked, certificate_decision
  ) values (
    request_record.id, submission.id, actual_amount_centavos, target_order.currency,
    trim(external_completion_reference), completion_time, actor, access_was_revoked, 'retained'
  ) returning * into result;

  update public.payment_submissions
  set status = 'refunded', review_reason = trim(reason), updated_at = now()
  where id = submission.id;

  insert into public.payment_events (submission_id, actor_id, event_type, reason)
  values (submission.id, actor, 'refunded_external', trim(reason));
  insert into public.audit_logs (actor_id, action, target_type, target_id, reason, metadata)
  values (
    actor, 'payment.refund_reconciled', 'payment_submission', submission.id::text, trim(reason),
    jsonb_build_object(
      'refundId', result.id, 'amountCentavos', result.amount_centavos,
      'accessRevoked', access_was_revoked, 'certificateDecision', 'retained'
    )
  );
  insert into public.email_outbox (idempotency_key, template, recipient_user_id, payload)
  values (
    'refund-completed:' || result.id, 'refund_completed', target_order.user_id,
    jsonb_build_object('refundId', result.id, 'amountCentavos', result.amount_centavos)
  ) on conflict (idempotency_key) do nothing;

  return result;
end;
$$;

create or replace function public.admin_financial_ledger(from_date date, through_date date)
returns table (
  event_at timestamptz,
  event_type text,
  submission_id uuid,
  order_id uuid,
  student_id uuid,
  reference_number text,
  gross_centavos integer,
  refund_centavos integer,
  net_centavos integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  lower_bound timestamptz;
  upper_bound timestamptz;
begin
  if not public.is_admin() then raise exception 'Administrator role required'; end if;
  if from_date is null or through_date is null or through_date < from_date then raise exception 'A valid date range is required'; end if;
  if through_date - from_date > 366 then raise exception 'Date range cannot exceed 366 days'; end if;
  lower_bound := from_date::timestamp at time zone 'Asia/Manila';
  upper_bound := (through_date + 1)::timestamp at time zone 'Asia/Manila';

  return query
  with ledger as (
    select ps.reviewed_at as event_at, 'approval'::text as event_type,
      ps.id as submission_id, o.id as order_id, o.user_id as student_id,
      ps.reference_number, ps.submitted_amount_centavos as gross_centavos,
      0 as refund_centavos, ps.submitted_amount_centavos as net_centavos
    from public.payment_submissions ps
    join public.orders o on o.id = ps.order_id
    where ps.status in ('approved', 'refunded') and ps.reviewed_at is not null
    union all
    select r.refunded_at, 'refund'::text, ps.id, o.id, o.user_id,
      ps.reference_number, 0, r.amount_centavos, -r.amount_centavos
    from public.refunds r
    join public.payment_submissions ps on ps.id = r.submission_id
    join public.orders o on o.id = ps.order_id
  )
  select ledger.* from ledger
  where ledger.event_at >= lower_bound and ledger.event_at < upper_bound
  order by ledger.event_at desc, ledger.submission_id;
end;
$$;

alter table public.refund_requests enable row level security;
alter table public.refunds enable row level security;
create policy refund_requests_admin_read on public.refund_requests for select to authenticated using (public.is_admin());
create policy refunds_admin_read on public.refunds for select to authenticated using (public.is_admin());
revoke all on public.refund_requests, public.refunds from anon, authenticated;
grant select on public.refund_requests, public.refunds to authenticated;
revoke all on function public.record_completed_refund(uuid, integer, text, timestamptz, text, boolean) from public, anon;
revoke all on function public.admin_financial_ledger(date, date) from public, anon;
grant execute on function public.record_completed_refund(uuid, integer, text, timestamptz, text, boolean) to authenticated;
grant execute on function public.admin_financial_ledger(date, date) to authenticated;
