create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create type public.app_language as enum ('en', 'ceb');
create type public.account_status as enum ('active', 'suspended');
create type public.course_status as enum ('draft', 'published', 'archived');
create type public.payment_method_type as enum ('gcash', 'maya', 'bank_transfer');
create type public.payment_status as enum ('pending', 'approved', 'rejected', 'resubmission_required', 'refunded');
create type public.enrollment_status as enum ('active', 'suspended', 'revoked');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null check (char_length(trim(full_name)) between 2 and 120),
  preferred_language public.app_language not null default 'en',
  account_status public.account_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.user_roles (
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('admin')),
  created_at timestamptz not null default now(),
  primary key (user_id, role)
);

create table public.policy_versions (
  id uuid primary key default gen_random_uuid(),
  policy_type text not null check (policy_type in ('terms', 'privacy')),
  version text not null,
  content_hash text not null,
  effective_at timestamptz,
  published boolean not null default false,
  unique (policy_type, version)
);

create table public.policy_acceptances (
  user_id uuid not null references auth.users(id) on delete cascade,
  policy_version_id uuid not null references public.policy_versions(id),
  accepted_at timestamptz not null default now(),
  primary key (user_id, policy_version_id)
);

create table public.courses (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  title text not null,
  description text not null default '',
  price_centavos integer not null check (price_centavos >= 0),
  currency text not null default 'PHP' check (currency = 'PHP'),
  status public.course_status not null default 'draft',
  sales_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.payment_methods (
  id uuid primary key default gen_random_uuid(),
  type public.payment_method_type not null unique,
  display_name text not null,
  destination_label text,
  destination_details text,
  instructions text,
  qr_object_path text,
  enabled boolean not null default false,
  updated_at timestamptz not null default now(),
  constraint enabled_method_has_destination check (
    not enabled or (destination_label is not null and destination_details is not null and instructions is not null)
  )
);

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  course_id uuid not null references public.courses(id),
  price_centavos integer not null check (price_centavos >= 0),
  currency text not null check (currency = 'PHP'),
  status text not null default 'open' check (status in ('open', 'paid', 'cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index one_open_order_per_user_course on public.orders(user_id, course_id) where status = 'open';
create index orders_user_created_idx on public.orders(user_id, created_at desc);

create table public.payment_submissions (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id),
  payment_method_id uuid not null references public.payment_methods(id),
  submitted_amount_centavos integer not null check (submitted_amount_centavos > 0),
  reference_number text not null check (char_length(trim(reference_number)) between 3 and 100),
  transaction_at timestamptz not null,
  status public.payment_status not null default 'pending',
  reviewer_id uuid references auth.users(id),
  reviewed_at timestamptz,
  review_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint review_fields_consistent check (
    (status = 'pending' and reviewer_id is null and reviewed_at is null)
    or (status <> 'pending' and reviewer_id is not null and reviewed_at is not null)
  )
);
create index payment_submissions_order_idx on public.payment_submissions(order_id, created_at desc);
create index payment_submissions_status_idx on public.payment_submissions(status, created_at);
create index payment_reference_review_idx on public.payment_submissions(lower(reference_number));

create table public.payment_proof_revisions (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.payment_submissions(id),
  revision integer not null check (revision > 0),
  object_path text not null unique,
  original_filename text not null,
  mime_type text not null check (mime_type in ('image/jpeg', 'image/png', 'application/pdf')),
  size_bytes integer not null check (size_bytes between 1 and 10485760),
  sha256 text not null,
  author_id uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  unique (submission_id, revision)
);

create table public.payment_events (
  id bigint generated always as identity primary key,
  submission_id uuid not null references public.payment_submissions(id),
  actor_id uuid not null references auth.users(id),
  event_type text not null,
  reason text,
  created_at timestamptz not null default now()
);

create table public.enrollments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  course_id uuid not null references public.courses(id),
  status public.enrollment_status not null default 'active',
  granted_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, course_id)
);

create table public.enrollment_grants (
  id uuid primary key default gen_random_uuid(),
  enrollment_id uuid not null references public.enrollments(id),
  source_type text not null check (source_type in ('payment', 'manual')),
  source_id uuid,
  reason text not null,
  active boolean not null default true,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);
create unique index unique_payment_grant on public.enrollment_grants(source_id) where source_type = 'payment';

create table public.audit_logs (
  id bigint generated always as identity primary key,
  actor_id uuid references auth.users(id),
  action text not null,
  target_type text not null,
  target_id text not null,
  reason text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_logs_target_idx on public.audit_logs(target_type, target_id, created_at desc);

create or replace function public.is_admin(target_user uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.user_roles where user_id = target_user and role = 'admin'
  );
$$;

create or replace function public.is_account_active(target_user uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles where id = target_user and account_status = 'active'
  );
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name, preferred_language)
  values (
    new.id,
    coalesce(nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''), 'Student'),
    case when new.raw_user_meta_data ->> 'preferred_language' = 'ceb'
      then 'ceb'::public.app_language else 'en'::public.app_language end
  );
  insert into public.policy_acceptances (user_id, policy_version_id)
  select new.id, id from public.policy_versions
  where (policy_type = 'terms' and version = new.raw_user_meta_data ->> 'terms_version')
     or (policy_type = 'privacy' and version = new.raw_user_meta_data ->> 'privacy_version');
  return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user();

create or replace function public.create_order(course_slug text)
returns public.orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_course public.courses;
  result public.orders;
  active_enrollment uuid;
begin
  if auth.uid() is null or not public.is_account_active(auth.uid()) then
    raise exception 'Authentication and an active account are required';
  end if;

  select * into selected_course
  from public.courses
  where slug = course_slug and status = 'published' and sales_enabled
  for share;

  if not found then
    raise exception 'This course is not currently available for checkout';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(auth.uid()::text || ':' || selected_course.id::text, 0)
  );

  select e.id into active_enrollment
  from public.enrollments e
  where e.user_id = auth.uid() and e.course_id = selected_course.id and e.status = 'active';

  if active_enrollment is not null then
    raise exception 'This account already has access to %; contact support instead of paying again',
      selected_course.title;
  end if;

  select * into result from public.orders
  where user_id = auth.uid() and course_id = selected_course.id and status = 'open';

  if found then return result; end if;

  insert into public.orders (user_id, course_id, price_centavos, currency)
  values (auth.uid(), selected_course.id, selected_course.price_centavos, selected_course.currency)
  returning * into result;
  return result;
end;
$$;

create or replace function public.create_payment_submission(
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
  selected_order public.orders;
  submission_id uuid;
begin
  select * into selected_order from public.orders
  where id = target_order_id and user_id = submission_user_id and status = 'open'
  for update;
  if not found or not public.is_account_active(submission_user_id) then
    raise exception 'Order is unavailable';
  end if;
  if amount_centavos <> selected_order.price_centavos then
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
  ) returning id into submission_id;

  insert into public.payment_proof_revisions (
    submission_id, revision, object_path, original_filename, mime_type, size_bytes, sha256, author_id
  ) values (
    submission_id, 1, proof_path, proof_filename, proof_mime, proof_size, proof_sha256, submission_user_id
  );
  insert into public.payment_events (submission_id, actor_id, event_type)
  values (submission_id, submission_user_id, 'submitted');
  return submission_id;
end;
$$;

revoke all on function public.is_admin(uuid) from public, anon, authenticated;
revoke all on function public.is_account_active(uuid) from public, anon, authenticated;
revoke all on function public.create_order(text) from public, anon, authenticated;
revoke all on function public.create_payment_submission(uuid, uuid, uuid, integer, text, timestamptz, text, text, text, integer, text) from public, anon, authenticated;
grant execute on function public.is_admin(uuid) to authenticated;
grant execute on function public.is_account_active(uuid) to authenticated;
grant execute on function public.create_order(text) to authenticated;
grant execute on function public.create_payment_submission(uuid, uuid, uuid, integer, text, timestamptz, text, text, text, integer, text) to service_role;

alter table public.profiles enable row level security;
alter table public.user_roles enable row level security;
alter table public.policy_versions enable row level security;
alter table public.policy_acceptances enable row level security;
alter table public.courses enable row level security;
alter table public.payment_methods enable row level security;
alter table public.orders enable row level security;
alter table public.payment_submissions enable row level security;
alter table public.payment_proof_revisions enable row level security;
alter table public.payment_events enable row level security;
alter table public.enrollments enable row level security;
alter table public.enrollment_grants enable row level security;
alter table public.audit_logs enable row level security;

create policy profiles_read_self_or_admin on public.profiles for select to authenticated
using ((id = auth.uid() and public.is_account_active(auth.uid())) or public.is_admin());
create policy profiles_update_self on public.profiles for update to authenticated
using (id = auth.uid() and public.is_account_active(auth.uid()))
with check (id = auth.uid() and public.is_account_active(auth.uid()));
create policy roles_admin_read on public.user_roles for select to authenticated using (public.is_admin());
create policy policies_public_read on public.policy_versions for select to anon, authenticated using (published);
create policy acceptances_read_self on public.policy_acceptances for select to authenticated using (user_id = auth.uid());
create policy acceptances_insert_self on public.policy_acceptances for insert to authenticated
with check (user_id = auth.uid() and exists (
  select 1 from public.policy_versions pv where pv.id = policy_version_id and pv.published
));
create policy courses_public_read on public.courses for select to anon, authenticated using (status = 'published' or public.is_admin());
create policy methods_enabled_read on public.payment_methods for select to authenticated
using ((enabled and public.is_account_active(auth.uid())) or public.is_admin());
create policy orders_read_owner_admin on public.orders for select to authenticated
using ((user_id = auth.uid() and public.is_account_active(auth.uid())) or public.is_admin());
create policy submissions_read_owner_admin on public.payment_submissions for select to authenticated
using (public.is_admin() or exists (
  select 1 from public.orders o where o.id = order_id and o.user_id = auth.uid() and public.is_account_active(auth.uid())
));
create policy proofs_read_owner_admin on public.payment_proof_revisions for select to authenticated
using (public.is_admin() or exists (
  select 1 from public.payment_submissions ps join public.orders o on o.id = ps.order_id
  where ps.id = submission_id and o.user_id = auth.uid() and public.is_account_active(auth.uid())
));
create policy events_read_owner_admin on public.payment_events for select to authenticated
using (public.is_admin() or exists (
  select 1 from public.payment_submissions ps join public.orders o on o.id = ps.order_id
  where ps.id = submission_id and o.user_id = auth.uid() and public.is_account_active(auth.uid())
));
create policy enrollments_read_owner_admin on public.enrollments for select to authenticated
using ((user_id = auth.uid() and public.is_account_active(auth.uid())) or public.is_admin());
create policy grants_admin_read on public.enrollment_grants for select to authenticated using (public.is_admin());
create policy audit_admin_read on public.audit_logs for select to authenticated using (public.is_admin());

revoke update on public.profiles from authenticated;
grant update (full_name, preferred_language, updated_at) on public.profiles to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('branding', 'branding', true, 5242880, array['image/jpeg', 'image/png', 'image/webp', 'image/svg+xml']),
  ('payment-proofs', 'payment-proofs', false, 10485760, array['image/jpeg', 'image/png', 'application/pdf']),
  ('course-materials', 'course-materials', false, 52428800, array['application/pdf']),
  ('course-sources', 'course-sources', false, 104857600, array['application/vnd.openxmlformats-officedocument.presentationml.presentation']),
  ('certificates', 'certificates', false, 10485760, array['application/pdf'])
on conflict (id) do nothing;

create policy payment_proofs_admin_read on storage.objects for select to authenticated
using (bucket_id = 'payment-proofs' and public.is_admin());
create policy payment_proofs_service_insert on storage.objects for insert to service_role
with check (bucket_id = 'payment-proofs');
create policy payment_proofs_service_delete on storage.objects for delete to service_role
using (bucket_id = 'payment-proofs');

insert into public.courses (slug, title, description, price_centavos, status, sales_enabled)
values ('logistics-101', 'Logistics 101', 'Beginner-focused logistics VA and 3PL freight brokerage training.', 69900, 'published', false)
on conflict (slug) do nothing;

insert into public.policy_versions (policy_type, version, content_hash, published)
values
  ('terms', 'development-draft-2026-10-03', encode(extensions.digest('development terms draft 2026-10-03', 'sha256'), 'hex'), false),
  ('privacy', 'development-draft-2026-10-03', encode(extensions.digest('development privacy draft 2026-10-03', 'sha256'), 'hex'), false)
on conflict (policy_type, version) do nothing;

insert into public.payment_methods (type, display_name, enabled)
values
  ('gcash', 'GCash', false),
  ('maya', 'Maya', false),
  ('bank_transfer', 'Bank transfer', false)
on conflict (type) do nothing;
