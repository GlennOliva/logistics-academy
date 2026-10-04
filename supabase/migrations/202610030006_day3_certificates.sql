create type public.certificate_status as enum ('pending', 'generating', 'active', 'failed', 'revoked');

create table public.course_certificate_configs (
  course_id uuid primary key references public.courses(id) on delete cascade,
  enabled boolean not null default false,
  required_module_count integer not null check (required_module_count > 0),
  minimum_score numeric(5,2) not null check (minimum_score >= 75 and minimum_score <= 100),
  template_version integer not null check (template_version > 0),
  template_sha256 text not null check (char_length(template_sha256) = 64),
  updated_at timestamptz not null default now()
);

create table public.certificates (
  id uuid primary key default gen_random_uuid(),
  enrollment_id uuid not null unique references public.enrollments(id),
  user_id uuid not null references auth.users(id),
  course_id uuid not null references public.courses(id),
  final_attempt_id uuid not null references public.quiz_attempts(id),
  verification_id text not null unique default (
    'LVA-' || to_char(now(), 'YYYY') || '-' || upper(encode(extensions.gen_random_bytes(8), 'hex'))
  ),
  student_name text not null,
  course_title text not null,
  required_module_count integer not null,
  final_score numeric(5,2) not null,
  completed_at timestamptz not null,
  status public.certificate_status not null default 'pending',
  template_version integer not null,
  template_sha256 text not null,
  object_path text unique,
  pdf_sha256 text,
  size_bytes integer check (size_bytes is null or size_bytes between 1 and 10485760),
  generation_token uuid,
  generation_lease_until timestamptz,
  failure_reason text,
  issued_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid references auth.users(id),
  revocation_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint active_certificate_has_file check (
    status <> 'active' or (object_path is not null and pdf_sha256 is not null and size_bytes is not null and issued_at is not null)
  ),
  constraint revoked_certificate_has_reason check (
    status <> 'revoked' or (revoked_at is not null and revoked_by is not null and char_length(trim(revocation_reason)) >= 3)
  )
);
create index certificates_user_idx on public.certificates(user_id, created_at desc);
create index certificates_verification_idx on public.certificates(verification_id);

create table private.certificate_verification_limits (
  request_key text not null,
  window_start timestamptz not null,
  request_count integer not null check (request_count > 0),
  primary key (request_key, window_start)
);

create or replace function public.ensure_certificate(target_enrollment uuid)
returns public.certificates
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  caller uuid := auth.uid();
  target public.enrollments;
  config public.course_certificate_configs;
  qualifying_attempt public.quiz_attempts;
  required_count integer;
  completed_count integer;
  name_snapshot text;
  title_snapshot text;
  result public.certificates;
begin
  if caller is null then raise exception 'Authentication required'; end if;

  select * into target from public.enrollments where id = target_enrollment for update;
  if not found then raise exception 'Enrollment not found'; end if;
  if target.user_id <> caller and not public.is_admin(caller) then raise exception 'Access denied'; end if;
  if target.status <> 'active' or not public.is_account_active(target.user_id) then
    raise exception 'An active enrollment and account are required';
  end if;

  select * into config from public.course_certificate_configs where course_id = target.course_id;
  if not found or not config.enabled then raise exception 'Certificate issuance is not enabled for this course'; end if;

  select count(*) filter (where em.required),
         count(*) filter (where em.required and mp.completed_at is not null)
  into required_count, completed_count
  from public.enrollment_modules em
  left join public.module_progress mp
    on mp.enrollment_id = em.enrollment_id and mp.module_id = em.module_id
  where em.enrollment_id = target.id;

  if required_count <> config.required_module_count then
    raise exception 'The enrollment does not contain the required certificate curriculum';
  end if;
  if completed_count <> required_count then raise exception 'All required modules must be completed'; end if;

  select qa.* into qualifying_attempt
  from public.quiz_attempts qa
  join public.quizzes q on q.id = qa.quiz_id
  where qa.enrollment_id = target.id
    and qa.kind = 'final'
    and q.course_id = target.course_id
    and qa.state = 'scored'
    and qa.passed is true
    and qa.score >= config.minimum_score
  order by qa.scored_at, qa.id
  limit 1;
  if not found then raise exception 'A passing final quiz score of at least % is required', config.minimum_score; end if;

  select full_name into name_snapshot from public.profiles where id = target.user_id;
  select title into title_snapshot from public.courses where id = target.course_id;

  insert into public.certificates (
    enrollment_id, user_id, course_id, final_attempt_id, student_name, course_title,
    required_module_count, final_score, completed_at, template_version, template_sha256
  ) values (
    target.id, target.user_id, target.course_id, qualifying_attempt.id, name_snapshot, title_snapshot,
    required_count, qualifying_attempt.score, qualifying_attempt.scored_at,
    config.template_version, config.template_sha256
  )
  on conflict (enrollment_id) do update set enrollment_id = excluded.enrollment_id
  returning * into result;

  return result;
end;
$$;

create or replace function public.claim_certificate_generation(target_certificate uuid, worker_token uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  claimed public.certificates;
begin
  update public.certificates
  set status = 'generating', generation_token = worker_token,
      generation_lease_until = now() + interval '5 minutes', failure_reason = null, updated_at = now()
  where id = target_certificate
    and (status in ('pending', 'failed') or (status = 'generating' and generation_lease_until < now()))
  returning * into claimed;

  if not found then
    select * into claimed from public.certificates where id = target_certificate;
    if not found then raise exception 'Certificate not found'; end if;
  end if;

  return jsonb_build_object(
    'id', claimed.id,
    'status', claimed.status,
    'claimed', claimed.generation_token = worker_token,
    'studentName', claimed.student_name,
    'courseTitle', claimed.course_title,
    'completedAt', claimed.completed_at,
    'verificationId', claimed.verification_id,
    'templateVersion', claimed.template_version,
    'templateSha256', claimed.template_sha256,
    'objectPath', coalesce(claimed.object_path, 'course/' || claimed.course_id || '/' || claimed.id || '.pdf')
  );
end;
$$;

create or replace function public.complete_certificate_generation(
  target_certificate uuid,
  worker_token uuid,
  generated_object_path text,
  generated_sha256 text,
  generated_size integer
)
returns public.certificates
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare result public.certificates;
begin
  update public.certificates
  set status = 'active', object_path = generated_object_path, pdf_sha256 = generated_sha256,
      size_bytes = generated_size, issued_at = coalesce(issued_at, now()),
      generation_token = null, generation_lease_until = null, failure_reason = null, updated_at = now()
  where id = target_certificate and status = 'generating' and generation_token = worker_token
  returning * into result;
  if not found then raise exception 'Certificate generation lease is invalid or expired'; end if;

  insert into public.email_outbox (idempotency_key, template, recipient_user_id, payload)
  values (
    'certificate-ready:' || result.id, 'certificate_ready', result.user_id,
    jsonb_build_object('certificateId', result.id, 'verificationId', result.verification_id)
  ) on conflict (idempotency_key) do nothing;

  return result;
end;
$$;

create or replace function public.fail_certificate_generation(target_certificate uuid, worker_token uuid, failure text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  update public.certificates
  set status = 'failed', generation_token = null, generation_lease_until = null,
      failure_reason = left(coalesce(nullif(trim(failure), ''), 'Generation failed'), 500), updated_at = now()
  where id = target_certificate and status = 'generating' and generation_token = worker_token;
end;
$$;

create or replace function public.issue_certificate_access(caller_user uuid, target_certificate uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when c.id is null then jsonb_build_object('allowed', false, 'error', 'Certificate not found')
    when c.status <> 'active' then jsonb_build_object('allowed', false, 'error', 'Certificate is not available')
    when c.user_id <> caller_user and not public.is_admin(caller_user) then jsonb_build_object('allowed', false, 'error', 'Access denied')
    when not public.is_account_active(caller_user) then jsonb_build_object('allowed', false, 'error', 'Account is not active')
    else jsonb_build_object(
      'allowed', true, 'objectPath', c.object_path, 'verificationId', c.verification_id,
      'studentName', c.student_name, 'courseTitle', c.course_title
    )
  end
  from (select 1) seed
  left join public.certificates c on c.id = target_certificate;
$$;

create or replace function public.verify_certificate_record(lookup_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare certificate_record public.certificates;
begin
  select * into certificate_record
  from public.certificates
  where verification_id = upper(trim(lookup_id));

  if not found then return jsonb_build_object('status', 'not_found'); end if;
  return jsonb_build_object(
    'status', case when certificate_record.status = 'active' then 'valid' when certificate_record.status = 'revoked' then 'revoked' else 'not_found' end,
    'verificationId', certificate_record.verification_id,
    'studentName', certificate_record.student_name,
    'courseTitle', certificate_record.course_title,
    'completedAt', certificate_record.completed_at,
    'issuedAt', certificate_record.issued_at
  );
end;
$$;

create or replace function public.check_certificate_rate_limit(request_key_hash text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare current_count integer;
declare current_window timestamptz := date_trunc('minute', now());
begin
  delete from private.certificate_verification_limits where window_start < now() - interval '10 minutes';
  insert into private.certificate_verification_limits (request_key, window_start, request_count)
  values (request_key_hash, current_window, 1)
  on conflict (request_key, window_start) do update
    set request_count = private.certificate_verification_limits.request_count + 1
  returning request_count into current_count;
  return current_count <= 30;
end;
$$;

alter table public.course_certificate_configs enable row level security;
alter table public.certificates enable row level security;

create policy certificate_configs_admin_read on public.course_certificate_configs
  for select to authenticated using (public.is_admin());
create policy certificates_owner_read on public.certificates
  for select to authenticated using (user_id = auth.uid() or public.is_admin());

revoke all on public.course_certificate_configs, public.certificates from anon, authenticated;
grant select on public.course_certificate_configs, public.certificates to authenticated;
revoke all on function public.ensure_certificate(uuid) from public, anon;
grant execute on function public.ensure_certificate(uuid) to authenticated;
revoke all on function public.claim_certificate_generation(uuid, uuid) from public, anon, authenticated;
revoke all on function public.complete_certificate_generation(uuid, uuid, text, text, integer) from public, anon, authenticated;
revoke all on function public.fail_certificate_generation(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.issue_certificate_access(uuid, uuid) from public, anon, authenticated;
revoke all on function public.verify_certificate_record(text) from public, anon, authenticated;
revoke all on function public.check_certificate_rate_limit(text) from public, anon, authenticated;
grant execute on function public.claim_certificate_generation(uuid, uuid) to service_role;
grant execute on function public.complete_certificate_generation(uuid, uuid, text, text, integer) to service_role;
grant execute on function public.fail_certificate_generation(uuid, uuid, text) to service_role;
grant execute on function public.issue_certificate_access(uuid, uuid) to service_role;
grant execute on function public.verify_certificate_record(text) to service_role;
grant execute on function public.check_certificate_rate_limit(text) to service_role;

insert into public.course_certificate_configs (
  course_id, enabled, required_module_count, minimum_score, template_version, template_sha256
)
select id, false, 8, 75, 1, '83d538deda959a93c91b7ee401a2cc43a4553fe766bc7352e21ab72783daef1b'
from public.courses where slug = 'logistics-101';
