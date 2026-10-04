alter table public.course_certificate_configs
  add column template_object_path text;

update public.course_certificate_configs
set template_object_path = 'logistics-101/v1/template.pdf'
where course_id = (select id from public.courses where slug = 'logistics-101');

alter table public.course_certificate_configs
  alter column template_object_path set not null,
  add constraint certificate_template_path_shape check (
    template_object_path = trim(template_object_path)
    and template_object_path !~ '(^|/)\.\.(/|$)'
    and template_object_path ~ '^[a-z0-9][a-z0-9/_-]*\.pdf$'
  );

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'certificate-templates',
  'certificate-templates',
  false,
  10485760,
  array['application/pdf']
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

-- No anon/authenticated storage.objects policy is created for this bucket.
-- Only service-role server code may retrieve the immutable source template.

create or replace function public.claim_certificate_generation(target_certificate uuid, worker_token uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  claimed public.certificates;
  template_path text;
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

  select template_object_path into template_path
  from public.course_certificate_configs
  where course_id = claimed.course_id;

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
    'templateObjectPath', template_path,
    'objectPath', coalesce(claimed.object_path, 'course/' || claimed.course_id || '/' || claimed.id || '.pdf')
  );
end;
$$;
