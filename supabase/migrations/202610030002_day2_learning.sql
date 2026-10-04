create type public.module_status as enum ('draft', 'published', 'archived');
create type public.quiz_kind as enum ('knowledge_check', 'final');
create type public.quiz_version_status as enum ('draft', 'published', 'archived');
create type public.attempt_state as enum ('in_progress', 'scored');
create type public.email_status as enum ('queued', 'sending', 'sent', 'failed');

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table public.modules (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.courses(id) on delete cascade,
  position integer not null check (position > 0),
  required boolean not null default true,
  status public.module_status not null default 'draft',
  curriculum_version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (course_id, position)
);
create index modules_course_status_idx on public.modules(course_id, status, position);

create table public.module_translations (
  id uuid primary key default gen_random_uuid(),
  module_id uuid not null references public.modules(id) on delete cascade,
  language public.app_language not null,
  version integer not null check (version > 0),
  title text not null check (char_length(trim(title)) between 1 and 200),
  summary text not null default '',
  object_path text not null unique,
  sha256 text not null,
  size_bytes integer not null check (size_bytes between 1 and 52428800),
  published boolean not null default false,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  unique (module_id, language, version)
);
create index module_translations_lookup_idx on public.module_translations(module_id, language, published, version desc);

create table public.enrollment_modules (
  enrollment_id uuid not null references public.enrollments(id) on delete cascade,
  module_id uuid not null references public.modules(id),
  required boolean not null,
  curriculum_version integer not null,
  created_at timestamptz not null default now(),
  primary key (enrollment_id, module_id)
);

create table public.module_progress (
  enrollment_id uuid not null references public.enrollments(id) on delete cascade,
  module_id uuid not null references public.modules(id),
  studied_at timestamptz,
  knowledge_check_completed_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (enrollment_id, module_id)
);
create index module_progress_enrollment_idx on public.module_progress(enrollment_id);

create table public.quizzes (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.courses(id) on delete cascade,
  module_id uuid references public.modules(id) on delete cascade,
  kind public.quiz_kind not null,
  created_at timestamptz not null default now(),
  unique (course_id, kind, module_id),
  constraint quiz_shape check ((kind = 'final' and module_id is null) or (kind = 'knowledge_check' and module_id is not null))
);
create unique index single_final_quiz_per_course on public.quizzes(course_id) where kind = 'final';

create table public.quiz_versions (
  id uuid primary key default gen_random_uuid(),
  quiz_id uuid not null references public.quizzes(id) on delete cascade,
  language public.app_language not null,
  version integer not null check (version > 0),
  status public.quiz_version_status not null default 'draft',
  pass_threshold numeric(5,2),
  max_attempts integer check (max_attempts is null or max_attempts > 0),
  cooldown_hours integer check (cooldown_hours is null or cooldown_hours >= 0),
  enabled boolean not null default false,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  published_at timestamptz,
  unique (quiz_id, language, version),
  constraint pass_threshold_range check (pass_threshold is null or (pass_threshold > 0 and pass_threshold <= 100))
);
create index quiz_versions_published_idx on public.quiz_versions(quiz_id, language, status, version desc);

create table public.quiz_questions (
  id uuid primary key default gen_random_uuid(),
  quiz_version_id uuid not null references public.quiz_versions(id) on delete cascade,
  position integer not null check (position > 0),
  prompt text not null check (char_length(trim(prompt)) between 1 and 2000),
  explanation text not null default '',
  required boolean not null default true,
  created_at timestamptz not null default now(),
  unique (quiz_version_id, position)
);

create table public.question_options (
  id uuid primary key default gen_random_uuid(),
  question_id uuid not null references public.quiz_questions(id) on delete cascade,
  position integer not null check (position > 0),
  label text not null check (char_length(trim(label)) between 1 and 500),
  unique (question_id, position)
);

create table private.quiz_answer_keys (
  question_id uuid primary key references public.quiz_questions(id) on delete cascade,
  option_id uuid not null references public.question_options(id) on delete cascade
);

create table public.quiz_attempts (
  id uuid primary key default gen_random_uuid(),
  enrollment_id uuid not null references public.enrollments(id) on delete cascade,
  user_id uuid not null references auth.users(id),
  quiz_id uuid not null references public.quizzes(id),
  quiz_version_id uuid not null references public.quiz_versions(id),
  kind public.quiz_kind not null,
  attempt_number integer not null check (attempt_number > 0),
  state public.attempt_state not null default 'in_progress',
  score numeric(5,2),
  passed boolean,
  correct_count integer,
  question_count integer,
  started_at timestamptz not null default now(),
  scored_at timestamptz,
  unique (enrollment_id, quiz_id, attempt_number)
);
create unique index one_open_attempt_per_quiz on public.quiz_attempts(enrollment_id, quiz_id) where state = 'in_progress';
create index quiz_attempts_user_idx on public.quiz_attempts(user_id, started_at desc);

create table public.attempt_answers (
  attempt_id uuid not null references public.quiz_attempts(id) on delete cascade,
  question_id uuid not null references public.quiz_questions(id),
  option_id uuid not null references public.question_options(id),
  is_correct boolean not null,
  primary key (attempt_id, question_id)
);

create table public.email_outbox (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  template text not null,
  recipient_user_id uuid not null references auth.users(id),
  payload jsonb not null default '{}'::jsonb,
  status public.email_status not null default 'queued',
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index email_outbox_pending_idx on public.email_outbox(status, next_attempt_at);

create table public.material_access_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id),
  enrollment_id uuid references public.enrollments(id),
  module_id uuid references public.modules(id),
  object_path text not null,
  event_type text not null check (event_type in ('link_issued', 'access_denied')),
  created_at timestamptz not null default now()
);
create index material_access_user_idx on public.material_access_events(user_id, created_at desc);

create or replace function public.snapshot_curriculum(target_enrollment uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_course uuid;
begin
  select course_id into target_course from public.enrollments where id = target_enrollment;
  if target_course is null then raise exception 'Enrollment not found'; end if;

  insert into public.enrollment_modules (enrollment_id, module_id, required, curriculum_version)
  select target_enrollment, m.id, m.required, m.curriculum_version
  from public.modules m
  where m.course_id = target_course and m.status = 'published'
  on conflict (enrollment_id, module_id) do nothing;
end;
$$;

create or replace function public.enrollment_progress(target_enrollment uuid)
returns table (required_total integer, required_complete integer, percent_complete integer, final_unlocked boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  totals record;
begin
  if not exists (
    select 1 from public.enrollments e
    where e.id = target_enrollment
      and ((e.user_id = auth.uid() and public.is_account_active(auth.uid())) or public.is_admin())
  ) then
    raise exception 'Enrollment not available';
  end if;

  select
    count(*) filter (where em.required)::integer as required_total,
    count(*) filter (where em.required and mp.completed_at is not null)::integer as required_complete
  into totals
  from public.enrollment_modules em
  left join public.module_progress mp
    on mp.enrollment_id = em.enrollment_id and mp.module_id = em.module_id
  where em.enrollment_id = target_enrollment;

  return query select
    totals.required_total,
    totals.required_complete,
    case when coalesce(totals.required_total, 0) = 0 then 0
      else round(totals.required_complete * 100.0 / totals.required_total)::integer end,
    totals.required_total > 0 and totals.required_complete = totals.required_total;
end;
$$;

create or replace function public.review_payment(target_submission uuid, decision text, reason text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  reviewer uuid := auth.uid();
  submission_row public.payment_submissions;
  order_row public.orders;
  enrollment_row uuid;
begin
  if reviewer is null or not public.is_admin(reviewer) then
    raise exception 'Administrator role required';
  end if;
  if decision not in ('approved', 'rejected', 'resubmission_required') then
    raise exception 'Unsupported decision';
  end if;
  if decision <> 'approved' and coalesce(length(trim(reason)), 0) < 3 then
    raise exception 'A reason is required for this decision';
  end if;

  select * into submission_row from public.payment_submissions where id = target_submission for update;
  if not found then raise exception 'Submission not found'; end if;

  select * into order_row from public.orders where id = submission_row.order_id for update;

  if submission_row.status = 'approved' then
    select id into enrollment_row from public.enrollments where user_id = order_row.user_id and course_id = order_row.course_id;
    return enrollment_row;
  end if;
  if submission_row.status not in ('pending', 'resubmission_required') then
    raise exception 'Submission cannot move from %', submission_row.status::text;
  end if;

  if decision = 'approved' then
    if submission_row.submitted_amount_centavos <> order_row.price_centavos then
      raise exception 'Submitted amount does not match the order amount; reconcile before approving';
    end if;

    update public.payment_submissions
    set status = 'approved', reviewer_id = reviewer, reviewed_at = now(), review_reason = null, updated_at = now()
    where id = target_submission;

    insert into public.enrollments (user_id, course_id, status)
    values (order_row.user_id, order_row.course_id, 'active')
    on conflict (user_id, course_id) do update set updated_at = now()
    returning id into enrollment_row;

    if (select status from public.enrollments where id = enrollment_row) = 'revoked' then
      raise exception 'Enrollment is revoked; use an explicit reinstatement action';
    end if;

    insert into public.enrollment_grants (enrollment_id, source_type, source_id, reason, created_by)
    values (enrollment_row, 'payment', target_submission, 'Approved payment submission', reviewer)
    on conflict do nothing;

    perform public.snapshot_curriculum(enrollment_row);

    update public.orders set status = 'paid', updated_at = now() where id = order_row.id;

    insert into public.email_outbox (idempotency_key, template, recipient_user_id, payload)
    values (
      'enrollment-approved:' || target_submission::text,
      'enrollment_approved',
      order_row.user_id,
      jsonb_build_object('course_title', (select title from public.courses where id = order_row.course_id))
    )
    on conflict (idempotency_key) do nothing;
  else
    update public.payment_submissions
    set status = decision::public.payment_status, reviewer_id = reviewer, reviewed_at = now(),
        review_reason = trim(reason), updated_at = now()
    where id = target_submission;
  end if;

  insert into public.payment_events (submission_id, actor_id, event_type, reason)
  values (target_submission, reviewer, decision, nullif(trim(reason), ''));

  insert into public.audit_logs (actor_id, action, target_type, target_id, reason)
  values (reviewer, 'payment.' || decision, 'payment_submission', target_submission::text, nullif(trim(reason), ''));

  return enrollment_row;
end;
$$;

create or replace function public.add_payment_proof_revision(
  submission_user_id uuid,
  target_submission uuid,
  target_method_id uuid,
  amount_centavos integer,
  payment_reference text,
  paid_at timestamptz,
  proof_path text,
  proof_filename text,
  proof_mime text,
  proof_size integer,
  proof_sha256 text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  submission_row public.payment_submissions;
  order_row public.orders;
  next_revision integer;
begin
  select * into submission_row
  from public.payment_submissions ps
  where ps.id = target_submission
    and exists (
      select 1 from public.orders o
      where o.id = ps.order_id and o.user_id = submission_user_id and o.status = 'open'
    )
  for update;

  if not found or not public.is_account_active(submission_user_id) then
    raise exception 'Submission is unavailable';
  end if;

  -- Load and lock the authoritative order before validating any client-supplied
  -- amount or object path. The ownership EXISTS check above scopes the
  -- submission, but it does not populate this composite row.
  select * into order_row
  from public.orders o
  where o.id = submission_row.order_id
    and o.user_id = submission_user_id
    and o.status = 'open'
  for update;

  if not found then
    raise exception 'Submission is unavailable';
  end if;

  if submission_row.status <> 'resubmission_required' then
    raise exception 'Only a resubmission-requested payment can receive corrected proof';
  end if;
  if amount_centavos <> order_row.price_centavos then
    raise exception 'Submitted amount must match the order amount';
  end if;
  if not exists (select 1 from public.payment_methods where id = target_method_id and enabled) then
    raise exception 'Payment method is unavailable';
  end if;
  if proof_path not like submission_user_id::text || '/' || order_row.id::text || '/%' then
    raise exception 'Invalid proof ownership path';
  end if;

  select coalesce(max(revision), 0) + 1 into next_revision
  from public.payment_proof_revisions where submission_id = target_submission;

  insert into public.payment_proof_revisions (
    submission_id, revision, object_path, original_filename, mime_type, size_bytes, sha256, author_id
  ) values (
    target_submission, next_revision, proof_path, proof_filename, proof_mime, proof_size, proof_sha256, submission_user_id
  );

  update public.payment_submissions
  set status = 'pending', payment_method_id = target_method_id, submitted_amount_centavos = amount_centavos,
      reference_number = trim(payment_reference), transaction_at = paid_at,
      reviewer_id = null, reviewed_at = null, review_reason = null, updated_at = now()
  where id = target_submission;

  insert into public.payment_events (submission_id, actor_id, event_type)
  values (target_submission, submission_user_id, 'resubmitted_revision_' || next_revision::text);

  return target_submission;
end;
$$;

create or replace function public.create_payment_resubmission(
  submission_user_id uuid,
  target_order_id uuid,
  target_method_id uuid,
  amount_centavos integer,
  payment_reference text,
  paid_at timestamptz,
  proof_path text,
  proof_filename text,
  proof_mime text,
  proof_size integer,
  proof_sha256 text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  order_row public.orders;
  new_submission uuid;
begin
  select * into order_row from public.orders
  where id = target_order_id and user_id = submission_user_id and status = 'open'
  for update;

  if not found or not public.is_account_active(submission_user_id) then
    raise exception 'Order is unavailable';
  end if;
  if amount_centavos <> order_row.price_centavos then
    raise exception 'Submitted amount must match the order amount';
  end if;
  if not exists (select 1 from public.payment_methods where id = target_method_id and enabled) then
    raise exception 'Payment method is unavailable';
  end if;
  if proof_path not like submission_user_id::text || '/' || target_order_id::text || '/%' then
    raise exception 'Invalid proof ownership path';
  end if;

  insert into public.payment_submissions (
    order_id, payment_method_id, submitted_amount_centavos, reference_number, transaction_at
  ) values (
    target_order_id, target_method_id, amount_centavos, trim(payment_reference), paid_at
  ) returning id into new_submission;

  insert into public.payment_proof_revisions (
    submission_id, revision, object_path, original_filename, mime_type, size_bytes, sha256, author_id
  ) values (
    new_submission, 1, proof_path, proof_filename, proof_mime, proof_size, proof_sha256, submission_user_id
  );

  insert into public.payment_events (submission_id, actor_id, event_type)
  values (new_submission, submission_user_id, 'reopened_after_rejection');

  return new_submission;
end;
$$;

create or replace function public.grant_manual_enrollment(
  target_user uuid,
  target_course uuid,
  grant_kind text,
  reason text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  operator_id uuid := auth.uid();
  enrollment_row uuid;
  existing_status public.enrollment_status;
begin
  if operator_id is null or not public.is_admin(operator_id) then
    raise exception 'Administrator role required';
  end if;
  if grant_kind not in ('complimentary', 'external_payment') then
    raise exception 'Unsupported grant kind';
  end if;
  if coalesce(length(trim(reason)), 0) < 3 then
    raise exception 'A reason is required for a manual grant';
  end if;
  if not exists (select 1 from public.courses where id = target_course) then
    raise exception 'Course not found';
  end if;

  insert into public.enrollments (user_id, course_id, status)
  values (target_user, target_course, 'active')
  on conflict (user_id, course_id) do update set updated_at = now()
  returning id into enrollment_row;

  select status into existing_status from public.enrollments where id = enrollment_row;
  if existing_status = 'revoked' then
    raise exception 'Enrollment is revoked; use an explicit reinstatement action';
  end if;

  insert into public.enrollment_grants (enrollment_id, source_type, reason, created_by)
  values (enrollment_row, 'manual', grant_kind || ': ' || trim(reason), operator_id);

  perform public.snapshot_curriculum(enrollment_row);

  insert into public.email_outbox (idempotency_key, template, recipient_user_id, payload)
  values (
    'manual-enrollment:' || enrollment_row::text || ':' || gen_random_uuid()::text,
    'manual_enrollment',
    target_user,
    jsonb_build_object('course_title', (select title from public.courses where id = target_course))
  );

  insert into public.audit_logs (actor_id, action, target_type, target_id, reason, metadata)
  values (
    operator_id, 'enrollment.manual_grant', 'enrollment', enrollment_row::text, trim(reason),
    jsonb_build_object('grant_kind', grant_kind, 'user_id', target_user, 'course_id', target_course)
  );

  return enrollment_row;
end;
$$;

create or replace function public.set_enrollment_access(target_enrollment uuid, new_status text, reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  operator_id uuid := auth.uid();
begin
  if operator_id is null or not public.is_admin(operator_id) then
    raise exception 'Administrator role required';
  end if;
  if new_status not in ('active', 'suspended', 'revoked') then
    raise exception 'Unsupported enrollment status';
  end if;
  if coalesce(length(trim(reason)), 0) < 3 then
    raise exception 'A reason is required';
  end if;

  update public.enrollments set status = new_status::public.enrollment_status, updated_at = now()
  where id = target_enrollment;

  if not found then raise exception 'Enrollment not found'; end if;

  insert into public.audit_logs (actor_id, action, target_type, target_id, reason)
  values (operator_id, 'enrollment.' || new_status, 'enrollment', target_enrollment::text, trim(reason));
end;
$$;

create or replace function public.set_account_status(target_user uuid, new_status text, reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  operator_id uuid := auth.uid();
begin
  if operator_id is null or not public.is_admin(operator_id) then
    raise exception 'Administrator role required';
  end if;
  if target_user = operator_id then
    raise exception 'Use a second administrator to change your own account status';
  end if;
  if new_status not in ('active', 'suspended') then
    raise exception 'Unsupported account status';
  end if;
  if coalesce(length(trim(reason)), 0) < 3 then
    raise exception 'A reason is required';
  end if;

  update public.profiles set account_status = new_status::public.account_status, updated_at = now()
  where id = target_user;
  if not found then raise exception 'Student not found'; end if;

  insert into public.audit_logs (actor_id, action, target_type, target_id, reason)
  values (operator_id, 'account.' || new_status, 'profile', target_user::text, trim(reason));
end;
$$;

create or replace function public.admin_save_module(
  target_course uuid,
  module_position integer,
  module_required boolean,
  action text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  operator_id uuid := auth.uid();
  module_row public.modules;
begin
  if operator_id is null or not public.is_admin(operator_id) then
    raise exception 'Administrator role required';
  end if;
  if not exists (select 1 from public.courses where id = target_course) then
    raise exception 'Course not found';
  end if;

  if action = 'create' then
    insert into public.modules (course_id, position, required, status)
    values (target_course, module_position, coalesce(module_required, true), 'draft')
    returning * into module_row;
  else
    select * into module_row from public.modules
    where id = action::uuid and course_id = target_course
    for update;
    if not found then raise exception 'Module not found'; end if;

    update public.modules
    set position = module_position, required = coalesce(module_required, required), updated_at = now()
    where id = module_row.id
    returning * into module_row;
  end if;

  insert into public.audit_logs (actor_id, action, target_type, target_id, metadata)
  values (operator_id, 'module.' || action, 'module', module_row.id::text,
    jsonb_build_object('position', module_row.position, 'required', module_row.required));

  return module_row.id;
end;
$$;

create or replace function public.admin_set_module_status(
  target_module uuid, new_status text, reason text, apply_to_existing boolean default false
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  operator_id uuid := auth.uid();
  target_course uuid;
  affected_enrollments integer := 0;
begin
  if operator_id is null or not public.is_admin(operator_id) then
    raise exception 'Administrator role required';
  end if;
  if new_status not in ('draft', 'published', 'archived') then
    raise exception 'Unsupported module status';
  end if;
  if coalesce(length(trim(reason)), 0) < 3 then
    raise exception 'A reason is required';
  end if;

  select course_id into target_course from public.modules where id = target_module;
  if target_course is null then raise exception 'Module not found'; end if;

  update public.modules set status = new_status::public.module_status, updated_at = now()
  where id = target_module;

  if new_status = 'published' and apply_to_existing then
    perform public.snapshot_curriculum(e.id)
    from public.enrollments e
    where e.course_id = target_course and e.status = 'active';
    get diagnostics affected_enrollments = row_count;
  end if;

  insert into public.audit_logs (actor_id, action, target_type, target_id, reason, metadata)
  values (operator_id, 'module.status', 'module', target_module::text, trim(reason),
    jsonb_build_object(
      'new_status', new_status,
      'applied_to_existing_enrollments', affected_enrollments,
      'note', case when new_status = 'published' and not apply_to_existing
        then 'Applies to new approvals only; existing enrollment snapshots were left unchanged'
        else 'Existing enrollment snapshots still reference this module'
      end));

  raise notice 'module % moved to %; existing enrollments updated: %',
    target_module, new_status, affected_enrollments;
end;
$$;

create or replace function public.admin_add_module_to_enrollments(target_module uuid, reason text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  operator_id uuid := auth.uid();
  target_course uuid;
  affected_enrollments integer := 0;
begin
  if operator_id is null or not public.is_admin(operator_id) then
    raise exception 'Administrator role required';
  end if;
  if coalesce(length(trim(reason)), 0) < 3 then
    raise exception 'A reason is required';
  end if;

  select course_id into target_course from public.modules where id = target_module;
  if target_course is null then raise exception 'Module not found'; end if;
  if not exists (select 1 from public.modules where id = target_module and status = 'published') then
    raise exception 'Only a published module can be added to existing enrollments';
  end if;

  perform public.snapshot_curriculum(e.id)
  from public.enrollments e
  where e.course_id = target_course and e.status = 'active';
  get diagnostics affected_enrollments = row_count;

  insert into public.audit_logs (actor_id, action, target_type, target_id, reason, metadata)
  values (operator_id, 'module.added_to_enrollments', 'module', target_module::text, trim(reason),
    jsonb_build_object('enrollments_updated', affected_enrollments));

  return affected_enrollments;
end;
$$;

create or replace function public.admin_set_course_sales(target_course uuid, sales boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  operator_id uuid := auth.uid();
  enabled_methods integer;
begin
  if operator_id is null or not public.is_admin(operator_id) then
    raise exception 'Administrator role required';
  end if;

  if sales then
    select count(*) into enabled_methods from public.payment_methods where enabled;
    if enabled_methods < 1 then
      raise exception 'Configure and enable at least one verified payment method before enabling sales';
    end if;
    if not exists (
      select 1 from public.modules m where m.course_id = target_course and m.status = 'published'
    ) then
      raise exception 'Publish at least one module before enabling sales';
    end if;
  end if;

  update public.courses set sales_enabled = sales, updated_at = now() where id = target_course;
  if not found then raise exception 'Course not found'; end if;

  insert into public.audit_logs (actor_id, action, target_type, target_id)
  values (operator_id, 'course.sales', 'course', target_course::text);
end;
$$;

create or replace function public.mark_module_studied(target_module uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  enrollment_row public.enrollments;
  has_translation boolean;
begin
  if auth.uid() is null or not public.is_account_active(auth.uid()) then
    raise exception 'Active account required';
  end if;

  select * into enrollment_row from public.enrollments
  where user_id = auth.uid() and course_id = (select course_id from public.modules where id = target_module)
    and status = 'active'
  for update;
  if not found then raise exception 'Active enrollment required'; end if;

  if not exists (
    select 1 from public.enrollment_modules em
    where em.enrollment_id = enrollment_row.id and em.module_id = target_module
  ) then
    raise exception 'Module is not part of your curriculum snapshot';
  end if;

  select exists (
    select 1 from public.module_translations mt
    where mt.module_id = target_module and mt.published
  ) into has_translation;
  if not has_translation then
    raise exception 'Module material is not published yet';
  end if;

  insert into public.module_progress (enrollment_id, module_id, studied_at)
  values (enrollment_row.id, target_module, now())
  on conflict (enrollment_id, module_id) do update
    set studied_at = coalesce(public.module_progress.studied_at, now()), updated_at = now();

  update public.module_progress mp set completed_at = now()
  where mp.enrollment_id = enrollment_row.id and mp.module_id = target_module
    and mp.studied_at is not null and mp.knowledge_check_completed_at is not null and mp.completed_at is null;
end;
$$;

create or replace function public.quiz_payload(target_attempt uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  attempt_row public.quiz_attempts;
  version_row public.quiz_versions;
begin
  select * into attempt_row from public.quiz_attempts where id = target_attempt;
  if not found then raise exception 'Attempt not found'; end if;
  if attempt_row.user_id <> auth.uid() and not public.is_admin() then
    raise exception 'Attempt not available';
  end if;
  if not public.is_admin() and not public.is_account_active(auth.uid()) then
    raise exception 'Active account required';
  end if;

  select * into version_row from public.quiz_versions where id = attempt_row.quiz_version_id;

  return jsonb_build_object(
    'attemptId', attempt_row.id,
    'kind', attempt_row.kind,
    'attemptNumber', attempt_row.attempt_number,
    'language', version_row.language,
    'state', attempt_row.state,
    'score', attempt_row.score,
    'passed', attempt_row.passed,
    'passThreshold', case when attempt_row.kind = 'final' then version_row.pass_threshold else null end,
    'questions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', q.id,
        'prompt', q.prompt,
        'options', (select jsonb_agg(jsonb_build_object('id', o.id, 'label', o.label) order by o.position)
                    from public.question_options o where o.question_id = q.id)
      ) order by q.position)
      from public.quiz_questions q
      where q.quiz_version_id = attempt_row.quiz_version_id and q.required
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.start_quiz_attempt(target_quiz uuid, attempt_language text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  enrollment_row public.enrollments;
  quiz_row public.quizzes;
  version_row public.quiz_versions;
  progress_row record;
  next_number integer;
  previous_scored timestamptz;
  attempt_row uuid;
  chosen_option_count integer;
begin
  if auth.uid() is null or not public.is_account_active(auth.uid()) then
    raise exception 'Active account required';
  end if;
  if attempt_language not in ('en', 'ceb') then
    raise exception 'Unsupported language';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(auth.uid()::text || ':' || target_quiz::text, 0));

  select * into quiz_row from public.quizzes where id = target_quiz;
  if not found then raise exception 'Quiz not found'; end if;

  select * into enrollment_row from public.enrollments
  where user_id = auth.uid() and course_id = quiz_row.course_id and status = 'active' for update;
  if not found then raise exception 'Active enrollment required'; end if;

  select * into version_row from public.quiz_versions
  where quiz_id = target_quiz and language = attempt_language::public.app_language
    and status = 'published'
  order by version desc limit 1;
  if not found then raise exception 'No published quiz version is available for the selected language'; end if;
  if not version_row.enabled then raise exception 'This assessment is not enabled yet'; end if;

  select count(*) into chosen_option_count
  from public.quiz_questions q
  where q.quiz_version_id = version_row.id and q.required
    and (select count(*) from public.question_options o where o.question_id = q.id) < 2;
  if chosen_option_count > 0 then raise exception 'This quiz version is not publishable'; end if;

  if quiz_row.kind = 'knowledge_check' then
    if not exists (
      select 1 from public.enrollment_modules em
      where em.enrollment_id = enrollment_row.id and em.module_id = quiz_row.module_id
    ) then
      raise exception 'This knowledge check is not part of your curriculum';
    end if;
  else
    select * into progress_row from public.enrollment_progress(enrollment_row.id);
    if not progress_row.final_unlocked then
      raise exception 'Complete all required modules before starting the final quiz';
    end if;
  end if;

  if exists (
    select 1 from public.quiz_attempts
    where enrollment_id = enrollment_row.id and quiz_id = target_quiz and state = 'in_progress'
  ) then
    raise exception 'An attempt is already in progress';
  end if;

  select coalesce(max(attempt_number), 0) + 1 into next_number
  from public.quiz_attempts where enrollment_id = enrollment_row.id and quiz_id = target_quiz;

  if version_row.max_attempts is not null and next_number > version_row.max_attempts then
    raise exception 'Attempt limit reached for this assessment';
  end if;

  if version_row.cooldown_hours is not null and version_row.cooldown_hours > 0 then
    select max(scored_at) into previous_scored from public.quiz_attempts
    where enrollment_id = enrollment_row.id and quiz_id = target_quiz and scored_at is not null;
    if previous_scored is not null and previous_scored > now() - make_interval(hours => version_row.cooldown_hours) then
      raise exception 'A waiting period applies before the next attempt';
    end if;
  end if;

  insert into public.quiz_attempts (enrollment_id, user_id, quiz_id, quiz_version_id, kind, attempt_number)
  values (enrollment_row.id, auth.uid(), target_quiz, version_row.id, quiz_row.kind, next_number)
  returning id into attempt_row;

  return attempt_row;
end;
$$;

create or replace function public.submit_quiz_attempt(target_attempt uuid, answers jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  attempt_row public.quiz_attempts;
  version_row public.quiz_versions;
  required_questions integer;
  correct_total integer := 0;
  score_value numeric(5,2);
  passed_value boolean;
  entry jsonb;
  question_key uuid;
  option_key uuid;
  module_key uuid;
  is_answer_correct boolean;
begin
  select * into attempt_row from public.quiz_attempts where id = target_attempt for update;
  if not found then raise exception 'Attempt not found'; end if;
  if attempt_row.user_id <> auth.uid() then raise exception 'Attempt not available'; end if;
  if not public.is_account_active(auth.uid()) then raise exception 'Active account required'; end if;

  select * into version_row from public.quiz_versions where id = attempt_row.quiz_version_id;

  if attempt_row.state = 'scored' then
    return jsonb_build_object(
      'attemptId', attempt_row.id,
      'score', attempt_row.score,
      'passed', attempt_row.passed,
      'correct', attempt_row.correct_count,
      'total', attempt_row.question_count,
      'alreadyScored', true
    );
  end if;

  if jsonb_typeof(answers) <> 'array' then raise exception 'Answers must be a list'; end if;

  for entry in select value from jsonb_array_elements(answers) loop
    if jsonb_typeof(entry -> 'questionId') <> 'string' or jsonb_typeof(entry -> 'optionId') <> 'string' then
      raise exception 'Each answer needs a questionId and optionId';
    end if;

    question_key := (entry ->> 'questionId')::uuid;
    option_key := (entry ->> 'optionId')::uuid;

    if not exists (
      select 1 from public.quiz_questions q
      where q.id = question_key and q.quiz_version_id = attempt_row.quiz_version_id and q.required
    ) then
      raise exception 'An answer references a question outside this assessment';
    end if;

    if not exists (
      select 1 from public.question_options o where o.id = option_key and o.question_id = question_key
    ) then
      raise exception 'An answer references an option that does not belong to the question';
    end if;

    select (ak.option_id = option_key) into is_answer_correct
    from private.quiz_answer_keys ak where ak.question_id = question_key;

    if is_answer_correct is null then
      raise exception 'This assessment version is missing an answer key';
    end if;

    insert into public.attempt_answers (attempt_id, question_id, option_id, is_correct)
    values (attempt_row.id, question_key, option_key, is_answer_correct)
    on conflict (attempt_id, question_id) do update
      set option_id = excluded.option_id, is_correct = excluded.is_correct;

    if is_answer_correct then correct_total := correct_total + 1; end if;
  end loop;

  select count(*) into required_questions from public.quiz_questions
  where quiz_version_id = attempt_row.quiz_version_id and required;

  if (select count(*) from public.attempt_answers where attempt_id = attempt_row.id) <> required_questions then
    raise exception 'Every required question must be answered exactly once';
  end if;

  score_value := round(correct_total * 100.0 / required_questions, 2);

  if attempt_row.kind = 'final' then
    if version_row.pass_threshold is null then
      raise exception 'The final quiz pass threshold is not configured';
    end if;
    passed_value := score_value >= version_row.pass_threshold;
  else
    passed_value := null;
  end if;

  update public.quiz_attempts
  set state = 'scored', score = score_value, passed = passed_value,
      correct_count = correct_total, question_count = required_questions, scored_at = now()
  where id = attempt_row.id;

  if attempt_row.kind = 'knowledge_check' then
    select module_id into module_key from public.quizzes where id = attempt_row.quiz_id;

    update public.module_progress mp
    set knowledge_check_completed_at = coalesce(mp.knowledge_check_completed_at, now()), updated_at = now()
    where mp.enrollment_id = attempt_row.enrollment_id and mp.module_id = module_key;

    update public.module_progress mp set completed_at = now()
    where mp.enrollment_id = attempt_row.enrollment_id and mp.module_id = module_key
      and mp.studied_at is not null and mp.knowledge_check_completed_at is not null and mp.completed_at is null;
  end if;

  return jsonb_build_object(
    'attemptId', attempt_row.id,
    'score', score_value,
    'passed', passed_value,
    'correct', correct_total,
    'total', required_questions,
    'passThreshold', case when attempt_row.kind = 'final' then version_row.pass_threshold else null end
  );
end;
$$;

revoke all on function public.snapshot_curriculum(uuid) from public, anon, authenticated;
revoke all on function public.enrollment_progress(uuid) from public, anon, authenticated;
revoke all on function public.review_payment(uuid, text, text) from public, anon, authenticated;
revoke all on function public.add_payment_proof_revision(uuid, uuid, uuid, integer, text, timestamptz, text, text, text, integer, text) from public, anon, authenticated;
revoke all on function public.create_payment_resubmission(uuid, uuid, uuid, integer, text, timestamptz, text, text, text, integer, text) from public, anon, authenticated;
revoke all on function public.grant_manual_enrollment(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.set_enrollment_access(uuid, text, text) from public, anon, authenticated;
revoke all on function public.set_account_status(uuid, text, text) from public, anon, authenticated;
revoke all on function public.admin_save_module(uuid, integer, boolean, text) from public, anon, authenticated;
revoke all on function public.admin_set_module_status(uuid, text, text, boolean) from public, anon, authenticated;
revoke all on function public.admin_add_module_to_enrollments(uuid, text) from public, anon, authenticated;
revoke all on function public.admin_set_course_sales(uuid, boolean) from public, anon, authenticated;
revoke all on function public.mark_module_studied(uuid) from public, anon, authenticated;
revoke all on function public.quiz_payload(uuid) from public, anon, authenticated;
revoke all on function public.start_quiz_attempt(uuid, text) from public, anon, authenticated;
revoke all on function public.submit_quiz_attempt(uuid, jsonb) from public, anon, authenticated;

grant execute on function public.enrollment_progress(uuid) to authenticated;
grant execute on function public.mark_module_studied(uuid) to authenticated;
grant execute on function public.quiz_payload(uuid) to authenticated;
grant execute on function public.start_quiz_attempt(uuid, text) to authenticated;
grant execute on function public.submit_quiz_attempt(uuid, jsonb) to authenticated;
grant execute on function public.review_payment(uuid, text, text) to authenticated;
grant execute on function public.grant_manual_enrollment(uuid, uuid, text, text) to authenticated;
grant execute on function public.set_enrollment_access(uuid, text, text) to authenticated;
grant execute on function public.set_account_status(uuid, text, text) to authenticated;
grant execute on function public.admin_save_module(uuid, integer, boolean, text) to authenticated;
grant execute on function public.admin_set_module_status(uuid, text, text, boolean) to authenticated;
grant execute on function public.admin_add_module_to_enrollments(uuid, text) to authenticated;
grant execute on function public.admin_set_course_sales(uuid, boolean) to authenticated;
grant execute on function public.snapshot_curriculum(uuid) to service_role;
grant execute on function public.add_payment_proof_revision(uuid, uuid, uuid, integer, text, timestamptz, text, text, text, integer, text) to service_role;
grant execute on function public.create_payment_resubmission(uuid, uuid, uuid, integer, text, timestamptz, text, text, text, integer, text) to service_role;

alter table public.modules enable row level security;
alter table public.module_translations enable row level security;
alter table public.enrollment_modules enable row level security;
alter table public.module_progress enable row level security;
alter table public.quizzes enable row level security;
alter table public.quiz_versions enable row level security;
alter table public.quiz_questions enable row level security;
alter table public.question_options enable row level security;
alter table public.quiz_attempts enable row level security;
alter table public.attempt_answers enable row level security;
alter table public.email_outbox enable row level security;
alter table public.material_access_events enable row level security;

create policy modules_read_published_or_admin on public.modules for select to authenticated
using ((status = 'published' and public.is_account_active(auth.uid())) or public.is_admin());
create policy translations_read_published_or_admin on public.module_translations for select to authenticated
using ((published and exists (
         select 1 from public.modules m where m.id = module_id and m.status = 'published'
       ) and public.is_account_active(auth.uid()))
  or public.is_admin());
create policy quizzes_read_student_or_admin on public.quizzes for select to authenticated
using (public.is_admin() or exists (
  select 1 from public.enrollments e
  where e.user_id = auth.uid() and e.course_id = course_id and e.status = 'active' and public.is_account_active(auth.uid())
));
create policy quiz_versions_read_student_or_admin on public.quiz_versions for select to authenticated
using (public.is_admin() or (status = 'published' and exists (
  select 1 from public.quizzes q join public.enrollments e on e.course_id = q.course_id
  where q.id = quiz_id and e.user_id = auth.uid() and e.status = 'active' and public.is_account_active(auth.uid())
)));
create policy quiz_questions_read_student_or_admin on public.quiz_questions for select to authenticated
using (public.is_admin() or exists (
  select 1 from public.quiz_versions qv
  join public.quizzes q on q.id = qv.quiz_id
  join public.enrollments e on e.course_id = q.course_id
  where qv.id = quiz_version_id and qv.status = 'published'
    and e.user_id = auth.uid() and e.status = 'active' and public.is_account_active(auth.uid())
));
create policy question_options_read_student_or_admin on public.question_options for select to authenticated
using (public.is_admin() or exists (
  select 1 from public.quiz_questions qq
  join public.quiz_versions qv on qv.id = qq.quiz_version_id
  join public.quizzes q on q.id = qv.quiz_id
  join public.enrollments e on e.course_id = q.course_id
  where qq.id = question_id and qv.status = 'published'
    and e.user_id = auth.uid() and e.status = 'active' and public.is_account_active(auth.uid())
));
create policy attempts_read_owner_admin on public.quiz_attempts for select to authenticated
using ((user_id = auth.uid() and public.is_account_active(auth.uid())) or public.is_admin());
create policy attempt_answers_read_owner_admin on public.attempt_answers for select to authenticated
using (public.is_admin() or exists (
  select 1 from public.quiz_attempts qa
  where qa.id = attempt_id and qa.user_id = auth.uid() and public.is_account_active(auth.uid())
));
create policy enrollment_modules_read_owner_admin on public.enrollment_modules for select to authenticated
using (public.is_admin() or exists (
  select 1 from public.enrollments e
  where e.id = enrollment_id and e.user_id = auth.uid() and e.status = 'active' and public.is_account_active(auth.uid())
));
create policy module_progress_read_owner_admin on public.module_progress for select to authenticated
using (public.is_admin() or exists (
  select 1 from public.enrollments e
  where e.id = enrollment_id and e.user_id = auth.uid() and e.status = 'active' and public.is_account_active(auth.uid())
));
create policy outbox_admin_read on public.email_outbox for select to authenticated using (public.is_admin());
create policy material_events_admin_read on public.material_access_events for select to authenticated using (public.is_admin());

revoke all on private.quiz_answer_keys from anon, authenticated;
revoke all on public.quiz_attempts, public.attempt_answers from anon, authenticated;

revoke all on public.modules, public.module_translations, public.enrollment_modules, public.module_progress,
  public.quizzes, public.quiz_versions, public.quiz_questions, public.question_options,
  public.quiz_attempts, public.attempt_answers, public.email_outbox, public.material_access_events
  from anon, authenticated;
grant select on public.modules, public.module_translations, public.quizzes, public.quiz_versions,
  public.quiz_questions, public.question_options, public.enrollment_modules, public.module_progress,
  public.quiz_attempts, public.email_outbox, public.material_access_events to authenticated;
grant select (attempt_id, question_id, option_id) on public.attempt_answers to authenticated;
