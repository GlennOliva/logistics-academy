-- Allow the three genuine module-material formats in the private course-materials
-- bucket. The bucket previously accepted application/pdf only, so the trusted
-- upload path could not store the supplied PowerPoint lessons even though the
-- edge function and the admin UI advertise PDF/PPT/PPTX support.
--
-- The bucket stays private; this only widens the accepted content types and
-- keeps the 50 MB ceiling that submit-course-material enforces in code.

update storage.buckets
  set allowed_mime_types = array[
        'application/pdf',
        'application/vnd.ms-powerpoint',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation'
      ],
      file_size_limit = 52428800,
      updated_at = now()
  where id = 'course-materials';

-- Guard against a silently missing or already-public bucket. A public bucket
-- would expose paid course material to anyone who can guess an object path.
do $$
begin
  if not exists (select 1 from storage.buckets where id = 'course-materials' and public = false) then
    raise exception 'course-materials bucket must exist and stay private';
  end if;
end;
$$;