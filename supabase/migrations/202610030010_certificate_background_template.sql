alter table public.course_certificate_configs
  drop constraint certificate_template_path_shape;

alter table public.course_certificate_configs
  add constraint certificate_template_path_shape check (
    template_object_path = trim(template_object_path)
    and template_object_path !~ '(^|/)\.\.(/|$)'
    and template_object_path ~ '^[a-z0-9][a-z0-9/_-]*\.(pdf|png)$'
  );

update storage.buckets
set allowed_mime_types = array['application/pdf', 'image/png']
where id = 'certificate-templates';

update public.course_certificate_configs
set template_version = 2,
    template_sha256 = '0ae273c023f8237fa990115257b21ef208637ba29b3d309b2b5e67cd039d9062',
    template_object_path = 'logistics-101/v2/background.png',
    updated_at = now()
where course_id = (select id from public.courses where slug = 'logistics-101');
