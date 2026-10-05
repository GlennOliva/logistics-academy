-- Removes only fixtures created by scripts/probe-module-lifecycle.mjs.
-- Matching is restricted to the probe's own naming conventions so real
-- curriculum modules, materials and learner records are never touched.

create temporary table probe_modules on commit drop as
  select id from public.modules where canonical_title like 'Lifecycle %';

create temporary table probe_users on commit drop as
  select id from auth.users where email like 'academy-mod-%';

create temporary table probe_enrollments on commit drop as
  select id from public.enrollments where user_id in (select id from probe_users);

-- storage.objects cannot be deleted from SQL (storage.protect_delete guard), so
-- probe objects are removed through the delete-material-version Edge Function,
-- which is the same trusted Storage API path the product uses.

delete from public.material_access_events
where user_id in (select id from probe_users)
   or module_id in (select id from probe_modules);

delete from public.email_delivery_events
where outbox_id in (
  select id from public.email_outbox where recipient_user_id in (select id from probe_users)
);

delete from public.email_outbox where recipient_user_id in (select id from probe_users);

delete from public.certificates where user_id in (select id from probe_users);

delete from public.quiz_attempts where user_id in (select id from probe_users);

delete from public.quiz_attempts
where quiz_id in (select id from public.quizzes where module_id in (select id from probe_modules));

delete from public.module_progress
where module_id in (select id from probe_modules)
   or enrollment_id in (select id from probe_enrollments);

delete from public.enrollment_modules
where module_id in (select id from probe_modules)
   or enrollment_id in (select id from probe_enrollments);

delete from public.enrollment_grants
where created_by in (select id from probe_users)
   or enrollment_id in (select id from probe_enrollments);

delete from public.quizzes where module_id in (select id from probe_modules);
delete from public.module_translations where module_id in (select id from probe_modules);

delete from public.enrollments where id in (select id from probe_enrollments);

-- Lifecycle RPCs write audit rows keyed to the acting admin and the target
-- object, and audit_logs.actor_id references auth.users, so probe audit rows
-- must go before the users themselves.
delete from public.audit_logs
where actor_id in (select id from probe_users)
   or target_id in (select id::text from probe_modules)
   or target_id in (
     select id::text from public.module_translations
     where module_id in (select id from probe_modules)
   )
   or target_id in (select id::text from probe_users);

delete from public.user_roles where user_id in (select id from probe_users);

-- profiles is keyed by the auth user id (profiles.id), not a user_id column.
delete from public.profiles where id in (select id from probe_users);

-- auth.users is deleted last so the child cleanup above still has ids to match.
delete from auth.users where id in (select id from probe_users);

delete from public.modules where id in (select id from probe_modules);

-- Markers let the Node probe read the counts out of the CLI's box-drawn table.
select 'PROBELEFT' || (select count(*) from public.modules where canonical_title like 'Lifecycle %')
     || '|' || (select count(*) from auth.users where email like 'academy-mod-%')
     || 'END' as leftovers;
