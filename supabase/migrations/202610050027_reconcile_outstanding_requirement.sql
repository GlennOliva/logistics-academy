-- Lets an admin reconcile an outstanding requirement difference, as found by
-- scripts/probe-module-lifecycle.mjs.
--
-- admin_edit_module only reconciled when the same save changed `required` or the
-- availability. An admin who changed the requirement without ticking the box was
-- then left with enrollment snapshots that disagreed with the module, and the Edit
-- dialog showed no control to fix it, because nothing had changed since. A
-- requested reconciliation is now honoured on its own.
--
-- Everything else in this function is unchanged from 202610050026.

begin;

create or replace function public.admin_edit_module(
  target_module uuid,
  new_canonical_title text,
  new_position integer,
  new_required boolean,
  new_status text,
  reason text,
  apply_to_existing boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  operator_id uuid := auth.uid();
  current_row public.modules;
  target_course uuid;
  title_before text;
  title_after text;
  position_before integer;
  position_after integer;
  required_before boolean;
  required_after boolean;
  status_before public.module_status;
  status_after public.module_status;
  requirement_reconciled boolean := false;
  availability_changed boolean := false;
  required_snapshot_count integer := 0;
  released_snapshots integer := 0;
  resnapshotted integer := 0;
  live_required_count integer;
  certificate_count_before integer;
  certificate_count_after integer;
begin
  if operator_id is null or not public.is_admin(operator_id) then
    raise exception 'Administrator role required';
  end if;
  if coalesce(length(trim(reason)), 0) < 3 then
    raise exception 'A reason is required';
  end if;

  select * into current_row from public.modules where id = target_module for update;
  if not found then raise exception 'Module not found'; end if;
  target_course := current_row.course_id;

  if current_row.archived_at is not null then
    raise exception 'This module is archived. Restore it before editing.';
  end if;

  title_after := nullif(trim(coalesce(new_canonical_title, '')), '');
  if title_after is not null and char_length(title_after) > 200 then
    raise exception 'Module title must be 200 characters or fewer';
  end if;

  if new_status is not null and new_status not in ('draft', 'published') then
    raise exception 'Use Archive to retire a module, or Restore to bring an archived one back';
  end if;

  position_after := coalesce(new_position, current_row.position);
  if position_after < 1 then raise exception 'Module order must be 1 or higher'; end if;

  required_after := coalesce(new_required, current_row.required);
  status_after := coalesce(new_status::public.module_status, current_row.status);

  title_before := current_row.canonical_title;
  position_before := current_row.position;
  required_before := current_row.required;
  status_before := current_row.status;

  -- Taking a module out of publication while students are still required to
  -- complete it would leave them blocked on something they cannot open. That is
  -- refused unless the same action reconciles their snapshots.
  if status_after <> 'published'::public.module_status
     and status_before = 'published'::public.module_status
     and required_after then
    select count(*) into required_snapshot_count
    from public.enrollment_modules where module_id = target_module and required;

    if required_snapshot_count > 0 and not apply_to_existing then
      raise exception
        'Current students are still required to complete this module, and it would no longer be open to them. Tick the reconciliation box to release the requirement in the same action, or archive the module instead.';
    end if;
  end if;

  -- modules has unique (course_id, position), so landing on an occupied slot
  -- moves three rows and the order is what makes it work. The moving module is
  -- parked on a free position first, which is what genuinely empties
  -- position_before. Sending the occupant straight to position_before while the
  -- moving module is still sitting there aborts on the unique constraint, which
  -- is why reordering previously appeared to do nothing.
  if position_after <> position_before then
    if exists (
      select 1 from public.modules
      where course_id = target_course and id <> target_module and position = position_after
    ) then
      update public.modules
      set position = (select coalesce(max(position), 0) + 1 from public.modules where course_id = target_course),
          updated_at = now()
      where id = target_module;

      update public.modules
      set position = position_before, updated_at = now()
      where course_id = target_course and id <> target_module and position = position_after;
    end if;
  end if;

  update public.modules
  set canonical_title = title_after,
      position = position_after,
      required = required_after,
      status = status_after,
      updated_at = now()
  where id = target_module;

  -- Reconciliation runs whenever it is explicitly asked for, not only when this
  -- save changed the requirement. Otherwise an admin who ticked the box once and
  -- then unticked it would be left with snapshots that disagree with the module
  -- and no way to bring them back into step.
  requirement_reconciled := apply_to_existing;

  if apply_to_existing then
    -- Republishing adds the module to current enrollments; unpublishing a module
    -- students are still required to finish releases that requirement so nobody
    -- is left blocked.
    if status_after <> 'published'::public.module_status and required_after then
      update public.enrollment_modules set required = false
      where module_id = target_module and required;
      get diagnostics released_snapshots = row_count;
    end if;

    update public.enrollment_modules em
    set required = required_after,
        curriculum_version = current_row.curriculum_version
    where em.module_id = target_module
      and status_after = 'published'::public.module_status
      and em.required is distinct from required_after;

    perform public.snapshot_curriculum(e.id)
    from public.enrollments e
    where e.course_id = target_course and e.status = 'active';
    get diagnostics resnapshotted = row_count;

    -- Certificate eligibility compares a learner's completed requirements with
    -- course_certificate_configs.required_module_count. Changing what students
    -- must complete without moving that number leaves an unattainable
    -- certificate, so the count is reconciled in the same confirmed action.
    select coalesce(required_module_count, 0) into certificate_count_before
    from public.course_certificate_configs where course_id = target_course;

    select count(*) into live_required_count
    from public.modules
    where course_id = target_course and required
      and status = 'published' and archived_at is null;

    update public.course_certificate_configs
    set required_module_count = live_required_count, updated_at = now()
    where course_id = target_course;

    select coalesce(required_module_count, 0) into certificate_count_after
    from public.course_certificate_configs where course_id = target_course;

    availability_changed := status_after is distinct from status_before;
  end if;

  insert into public.audit_logs (actor_id, action, target_type, target_id, reason, metadata)
  values (operator_id, 'module.edited', 'module', target_module::text, trim(reason),
    jsonb_build_object(
      'title_before', title_before,
      'title_after', title_after,
      'position_before', position_before,
      'position_after', position_after,
      'required_before', required_before,
      'required_after', required_after,
      'status_before', status_before,
      'status_after', status_after,
      'requirement_reconciled', requirement_reconciled,
      'availability_changed', availability_changed,
      'snapshot_requirements_released', released_snapshots,
      'enrollments_resnapshotted', resnapshotted,
      'certificate_required_module_count_before', certificate_count_before,
      'certificate_required_module_count_after', certificate_count_after));

  return jsonb_build_object(
    'moduleId', target_module,
    'title', coalesce(title_after, title_before),
    'position', position_after,
    'required', required_after,
    'status', status_after,
    'requirementReconciled', requirement_reconciled,
    'snapshotRequirementsReleased', released_snapshots,
    'enrollmentsResnapshotted', resnapshotted,
    'certificateRequiredModuleCount', certificate_count_after,
    'filesReplaced', false
  );
end;
$$;

commit;
