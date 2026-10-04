-- Generate certificates from the owner-supplied landscape artwork itself instead of
-- a rasterised screenshot of it, and expose the required module count so the
-- generator can refuse to print the template's fixed "all 8 modules" wording for a
-- curriculum of a different length.

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
    'requiredModuleCount', claimed.required_module_count,
    'templateVersion', claimed.template_version,
    'templateSha256', claimed.template_sha256,
    'templateObjectPath', template_path,
    'objectPath', coalesce(claimed.object_path, 'course/' || claimed.course_id || '/' || claimed.id || '.pdf')
  );
end;
$$;

update public.course_certificate_configs
set template_version = 3,
    template_sha256 = '83d538deda959a93c91b7ee401a2cc43a4553fe766bc7352e21ab72783daef1b',
    template_object_path = 'logistics-101/v3/template.pdf',
    updated_at = now()
where course_id = (select id from public.courses where slug = 'logistics-101');