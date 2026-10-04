-- Day 2 authorization, transaction, progress, and scoring assertions.
-- Runs as the harness superuser while switching between anon, authenticated,
-- and admin identities to prove database behavior rather than UI behavior.

\set ON_ERROR_STOP on

select id as course_id from public.courses where slug = 'logistics-101' \gset

insert into auth.users (id, email, raw_user_meta_data) values
  ('11111111-1111-4111-8111-111111111111', 'student-a@example.test',
    '{"full_name":"Student A","preferred_language":"en","terms_version":"development-draft-2026-10-03","privacy_version":"development-draft-2026-10-03"}'),
  ('22222222-2222-4222-8222-222222222222', 'student-b@example.test',
    '{"full_name":"Student B","preferred_language":"ceb","terms_version":"development-draft-2026-10-03","privacy_version":"development-draft-2026-10-03"}'),
  ('33333333-3333-4333-8333-333333333333', 'suspended@example.test',
    '{"full_name":"Suspended Student","preferred_language":"en","terms_version":"development-draft-2026-10-03","privacy_version":"development-draft-2026-10-03"}'),
  ('44444444-4444-4444-8444-444444444444', 'concurrent@example.test',
    '{"full_name":"Concurrent Student","preferred_language":"en","terms_version":"development-draft-2026-10-03","privacy_version":"development-draft-2026-10-03"}'),
  ('99999999-9999-4999-8999-999999999999', 'admin@example.test',
    '{"full_name":"Admin One","preferred_language":"en","terms_version":"development-draft-2026-10-03","privacy_version":"development-draft-2026-10-03"}');

insert into public.user_roles (user_id, role)
values ('99999999-9999-4999-8999-999999999999', 'admin');

update public.profiles set account_status = 'suspended' where id = '33333333-3333-4333-8333-333333333333';

select harness.check(
  (select count(*) from public.policy_acceptances where user_id = '11111111-1111-4111-8111-111111111111') = 2,
  'signup records both versioned policy acknowledgements');

select harness.check(
  (select full_name from public.profiles where id = '11111111-1111-4111-8111-111111111111') = 'Student A',
  'profile is created from trusted signup metadata');

select harness.check(
  (select count(*) from public.payment_methods where enabled) = 2
  and (select enabled from public.payment_methods where type = 'gcash')
  and (select display_name = 'MariBank' and enabled from public.payment_methods where type = 'bank_transfer')
  and not (select enabled from public.payment_methods where type = 'maya'),
  'GCash and MariBank are the only configured payment methods');

-- Isolate the original single-method fixture from the configured method set.
update public.payment_methods set enabled = false;
update public.payment_methods
set enabled = true, destination_label = 'TEST GCASH NUMBER', destination_details = '0000-000-000 (test fixture)',
    instructions = 'TEST transfer only. Do not use real funds.'
where type = 'gcash';

set role anon;
select harness.check(
  (select count(*) from public.courses where slug = 'logistics-101' and status = 'published') = 1,
  'anonymous visitors can read a published course without executing admin helpers');
reset role;

-- ---------------------------------------------------------------------------
-- Admin content management
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"99999999-9999-4999-8999-999999999999","role":"authenticated"}', false);

select id as module_one from public.modules where course_id = :'course_id' and position = 1 \gset
select id as module_two from public.modules where course_id = :'course_id' and position = 2 \gset
select id as module_three from public.modules where course_id = :'course_id' and position = 3 \gset
select public.admin_save_module(:'course_id', 1, true, :'module_one');

select harness.check(
  (select count(*) from public.modules where course_id = :'course_id') = 8
  and (select canonical_title from public.modules where id = :'module_three') = 'Carrier Sourcing',
  'approved module catalog is repeatable and editable through the trusted operation');

select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}', false);
select harness.expect_error(
  format('select public.admin_save_module(%L, 9, true, %L)', :'course_id', 'create'),
  'Administrator role required',
  'non-admin cannot create modules');
select harness.check(
  (select count(*) from public.modules where course_id = :'course_id') = 0,
  'a student sees no draft modules through RLS');
select harness.expect_error(
  format('select public.admin_set_module_status(%L, ''published'', ''self publish'')', :'module_one'),
  'Administrator role required',
  'non-admin cannot publish a module');
select harness.expect_error(
  format('select public.admin_set_course_sales(%L, true)', :'course_id'),
  'Administrator role required',
  'non-admin cannot enable sales');
select set_config('request.jwt.claims', '{"sub":"99999999-9999-4999-8999-999999999999","role":"authenticated"}', false);

select harness.check(
  (select count(*) from public.modules where course_id = :'course_id') = 8,
  'the refused admin calls left no module behind');

select public.admin_set_module_status(:'module_one', 'published', 'test fixture publication');
select public.admin_set_module_status(:'module_two', 'published', 'test fixture publication');
select public.admin_set_module_status(:'module_three', 'draft', 'test fixture draft');

select public.admin_set_course_sales(:'course_id', true);

select harness.check(
  (select sales_enabled from public.courses where id = :'course_id')
  and (select status from public.modules where id = :'module_three') = 'draft',
  'sales is enabled while unpublished modules stay out of the curriculum');

select harness.expect_no_change(
  format('update public.courses set price_centavos = 100 where id = %L', :'course_id'),
  'even an administrator cannot edit the price with a direct client update');
reset role;

select harness.check(
  (select price_centavos from public.courses where id = :'course_id') = 69900,
  'the authoritative price is unchanged after the refused update');

insert into public.module_translations (module_id, language, version, title, summary, object_path, sha256, size_bytes, published, created_by)
values
  (:'module_one', 'en', 1, 'Logistics Fundamentals', 'Fixture lesson', 'course-materials/m1/en/v1.pdf', repeat('a', 64), 1024, true, '99999999-9999-4999-8999-999999999999'),
  (:'module_one', 'ceb', 1, 'Fundamentals sa Logistics', 'Fixture lesson', 'course-materials/m1/ceb/v1.pdf', repeat('b', 64), 1024, true, '99999999-9999-4999-8999-999999999999'),
  (:'module_two', 'en', 1, 'Trucks and Equipment', 'Fixture lesson', 'course-materials/m2/en/v1.pdf', repeat('c', 64), 1024, true, '99999999-9999-4999-8999-999999999999');

select harness.check(
  (select count(*) from public.module_translations where module_id = :'module_one') = 2,
  'English and Bisaya materials are separate immutable versions');

insert into public.quizzes (id, course_id, module_id, kind) values
  ('a1111111-1111-4111-8111-111111111111', :'course_id', :'module_one', 'knowledge_check'),
  ('a1111111-1111-4111-8111-111111111113', :'course_id', :'module_two', 'knowledge_check'),
  ('b2222222-2222-4222-8222-222222222222', :'course_id', null, 'final');

insert into public.quiz_versions (id, quiz_id, language, version, status, pass_threshold, max_attempts, cooldown_hours, enabled, created_by, published_at) values
  ('a1111111-1111-4111-8111-111111111112', 'a1111111-1111-4111-8111-111111111111', 'en', 1, 'published', null, null, null, true, '99999999-9999-4999-8999-999999999999', now()),
  ('a1111111-1111-4111-8111-111111111114', 'a1111111-1111-4111-8111-111111111113', 'en', 1, 'published', null, null, null, true, '99999999-9999-4999-8999-999999999999', now()),
  ('b2222222-2222-4222-8222-222222222223', 'b2222222-2222-4222-8222-222222222222', 'en', 1, 'published', 75, 3, null, true, '99999999-9999-4999-8999-999999999999', now());

insert into public.quiz_questions (id, quiz_version_id, position, prompt, explanation) values
  ('c1111111-1111-4111-8111-111111111111', 'a1111111-1111-4111-8111-111111111112', 1, 'Bill of lading question one?', 'Review the lesson.'),
  ('c1111111-1111-4111-8111-111111111112', 'a1111111-1111-4111-8111-111111111112', 2, 'Bill of lading question two?', 'Review the lesson.'),
  ('e1111111-1111-4111-8111-111111111111', 'a1111111-1111-4111-8111-111111111114', 1, 'Equipment question one?', 'Review the lesson.'),
  ('d2222222-2222-4222-8222-222222222221', 'b2222222-2222-4222-8222-222222222223', 1, 'Final question one?', ''),
  ('d2222222-2222-4222-8222-222222222222', 'b2222222-2222-4222-8222-222222222223', 2, 'Final question two?', ''),
  ('d2222222-2222-4222-8222-222222222223', 'b2222222-2222-4222-8222-222222222223', 3, 'Final question three?', ''),
  ('d2222222-2222-4222-8222-222222222224', 'b2222222-2222-4222-8222-222222222223', 4, 'Final question four?', '');

insert into public.question_options (id, question_id, position, label)
select gen_random_uuid(), q.id, p.position, 'Option ' || p.position
from public.quiz_questions q
cross join (values (1),(2),(3),(4)) as p(position)
where q.quiz_version_id in ('a1111111-1111-4111-8111-111111111112','a1111111-1111-4111-8111-111111111114','b2222222-2222-4222-8222-222222222223');

insert into private.quiz_answer_keys (question_id, option_id)
select q.id, o.id
from public.quiz_questions q
join public.question_options o on o.question_id = q.id and o.position = 1
where q.quiz_version_id in ('a1111111-1111-4111-8111-111111111112','a1111111-1111-4111-8111-111111111114','b2222222-2222-4222-8222-222222222223');

-- Correct and wrong option ids are read once as the harness superuser so the
-- student-role assertions never need access to the private answer key.
select option_id as key_kc_one from private.quiz_answer_keys where question_id = 'c1111111-1111-4111-8111-111111111111' \gset
select option_id as key_kc_two from private.quiz_answer_keys where question_id = 'e1111111-1111-4111-8111-111111111111' \gset
select option_id as key_final_one from private.quiz_answer_keys where question_id = 'd2222222-2222-4222-8222-222222222221' \gset
select option_id as key_final_two from private.quiz_answer_keys where question_id = 'd2222222-2222-4222-8222-222222222222' \gset
select option_id as key_final_three from private.quiz_answer_keys where question_id = 'd2222222-2222-4222-8222-222222222223' \gset
select option_id as key_final_four from private.quiz_answer_keys where question_id = 'd2222222-2222-4222-8222-222222222224' \gset

-- ---------------------------------------------------------------------------
-- Authoritative pricing and account state
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}', false);
select public.create_order('logistics-101');
select id as order_a_id, price_centavos as order_a_price from public.orders where user_id = auth.uid() \gset

select harness.check(
  :'order_a_price' = '69900',
  'order snapshots the authoritative 69900 centavos price');

select harness.check(
  (select count(*) from public.payment_methods) = 1,
  'an active student only sees the one enabled payment method');

select set_config('request.jwt.claims', '{"sub":"33333333-3333-4333-8333-333333333333","role":"authenticated"}', false);
select harness.expect_error(
  'select public.create_order(''logistics-101'')',
  'active account are required',
  'a suspended account cannot order with an existing session');
select harness.check(
  (select count(*) from public.payment_methods) = 0,
  'a suspended account sees no payment destinations at all');
reset role;

select harness.check(
  (select count(*) from public.payment_methods) = 3
  and (select count(*) from public.payment_methods where enabled) = 1,
  'exactly one of the three payment methods is enabled and the rest stay closed');

set role anon;
select harness.expect_denied('select public.create_order(''logistics-101'')', 'anonymous callers cannot create orders');
select harness.expect_no_rows('select * from public.payment_submissions', 'anonymous callers see no payment submissions');
select harness.expect_no_rows('select * from public.orders', 'anonymous callers see no orders');
select harness.expect_no_rows('select * from storage.objects where bucket_id = ''course-materials''', 'anonymous callers see no course material objects');
select harness.expect_no_rows('select * from storage.objects where bucket_id = ''payment-proofs''', 'anonymous callers see no payment proof objects');
select harness.expect_denied('select * from public.quizzes', 'anonymous callers cannot read assessment definitions');
select harness.expect_denied('select * from public.quiz_questions', 'anonymous callers cannot read assessment questions');
select harness.expect_denied('select * from public.module_translations', 'anonymous callers cannot read module materials');
reset role;

select public.create_payment_submission(
  '11111111-1111-4111-8111-111111111111', :'order_a_id',
  (select id from public.payment_methods where enabled),
  69900, 'REF-A-001', now(),
  '11111111-1111-4111-8111-111111111111/' || :'order_a_id' || '/proof.png',
  'proof.png', 'image/png', 2048, repeat('c', 64)
) as sub_a \gset

update public.payment_submissions set submitted_amount_centavos = 65000 where id = :'sub_a';

select harness.check(
  (select status from public.payment_submissions where id = :'sub_a') = 'pending'
  and (select count(*) from public.enrollments) = 0,
  'a persisted proof submission stays pending and grants nothing');

-- ---------------------------------------------------------------------------
-- Student isolation and write restrictions
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}', false);

select harness.check(
  (select count(*) from public.payment_submissions) = 1
  and (select id from public.payment_submissions) = :'sub_a'::uuid,
  'Student A reads only their own payment submission');

select harness.check(
  (select count(*) from public.payment_proof_revisions) = 1,
  'Student A reads only their own proof revision metadata');

select harness.check(
  (select count(*) from public.enrollments) = 0
  and (select count(*) from public.quiz_attempts) = 0,
  'an unpaid student has no enrollment or attempt records');

select harness.expect_no_change(
  format('update public.payment_submissions set status = ''approved'' where id = %L', :'sub_a'),
  'a student update to payment status matches no writable row');
select harness.check(
  (select status from public.payment_submissions where id = :'sub_a') = 'pending',
  'the refused status write left the submission pending');
select harness.expect_denied(
  'insert into public.enrollment_grants (enrollment_id, source_type, reason, created_by) values (gen_random_uuid(), ''manual'', ''self service'', auth.uid())',
  'students cannot fabricate enrollment grants');
select harness.expect_denied(
  'select * from private.quiz_answer_keys',
  'students cannot read the answer key schema');
select harness.expect_denied(
  'select is_correct from public.attempt_answers',
  'per-question correctness is not student readable');
select harness.expect_denied(
  'insert into public.user_roles (user_id, role) values (auth.uid(), ''admin'')',
  'students cannot self-assign the admin role');
select harness.expect_denied(
  format('update public.profiles set account_status = ''active'' where id = %L', '33333333-3333-4333-8333-333333333333'),
  'a student cannot change another account status');
select harness.expect_denied(
  format('update public.profiles set account_status = ''suspended'' where id = %L', auth.uid()),
  'the column grant does not let a student suspend their own account');
select harness.check(
  (select account_status from public.profiles where id = auth.uid()) = 'active',
  'the refused status writes left the student account active');
select harness.check(
  (select account_status from public.profiles where id = auth.uid()) is not null
  and (select count(*) from public.profiles where id = '33333333-3333-4333-8333-333333333333') = 0,
  'RLS hides other profiles from a student, so even their status is not readable');
select harness.expect_no_rows(
  'select * from storage.objects where bucket_id = ''payment-proofs''',
  'students see no private payment proof objects');
reset role;

set role authenticated;
select set_config('request.jwt.claims', '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}', false);
select public.create_order('logistics-101');
select id as order_b_id from public.orders where user_id = auth.uid() \gset
select harness.check(
  (select count(*) from public.payment_submissions) = 0,
  'a second unpaid student sees an empty payment history');
reset role;

set role authenticated;
select set_config('request.jwt.claims', '{"sub":"44444444-4444-4444-8444-444444444444","role":"authenticated"}', false);
select public.create_order('logistics-101');
select id as order_d_id from public.orders where user_id = auth.uid() \gset
reset role;

select public.create_payment_submission(
  '22222222-2222-4222-8222-222222222222', :'order_b_id',
  (select id from public.payment_methods where enabled),
  69900, 'REF-B-001', now(),
  '22222222-2222-4222-8222-222222222222/' || :'order_b_id' || '/proof.png',
  'proof.png', 'image/png', 2048, repeat('d', 64)
) as sub_b \gset

select public.create_payment_submission(
  '44444444-4444-4444-8444-444444444444', :'order_d_id',
  (select id from public.payment_methods where enabled),
  69900, 'REF-D-001', now(),
  '44444444-4444-4444-8444-444444444444/' || :'order_d_id' || '/proof.png',
  'proof.png', 'image/png', 2048, repeat('e', 64)
) as sub_d \gset

set role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}', false);
select harness.check(
  (select count(*) from public.payment_submissions) = 1,
  'Student A still cannot see the other students submissions after they are created');
select harness.expect_error(
  format('select public.review_payment(%L, ''approved'', null)', :'sub_a'),
  'Administrator role required',
  'a student cannot approve their own payment');
reset role;

-- ---------------------------------------------------------------------------
-- Trusted review, enrollment, and history
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"99999999-9999-4999-8999-999999999999","role":"authenticated"}', false);

select harness.expect_error(
  format('select public.review_payment(%L, ''approved'', null)', :'sub_a'),
  'does not match the order amount',
  'approval is refused while the submitted amount is unreconciled');

select harness.expect_error(
  format('select public.review_payment(%L, ''rejected'', ''no'')', :'sub_a'),
  'reason is required',
  'rejection requires a recorded reason');
reset role;

update public.payment_submissions set submitted_amount_centavos = 69900 where id = :'sub_a';

set role authenticated;
select set_config('request.jwt.claims', '{"sub":"99999999-9999-4999-8999-999999999999","role":"authenticated"}', false);

select public.review_payment(:'sub_a', 'approved', null) as enrollment_a \gset

select harness.check(
  (select status from public.payment_submissions where id = :'sub_a') = 'approved'
  and (select status from public.enrollments where id = :'enrollment_a') = 'active'
  and (select status from public.orders where id = :'order_a_id') = 'paid',
  'approval updates payment, enrollment and order together');

select harness.check(
  (select count(*) from public.enrollment_grants where enrollment_id = :'enrollment_a'::uuid) = 1
  and (select count(*) from public.email_outbox where idempotency_key = 'enrollment-approved:' || :'sub_a') = 1
  and (select count(*) from public.audit_logs where action = 'payment.approved') = 1,
  'approval writes exactly one grant, one confirmation event and one audit record');

select harness.check(
  (select count(*) from public.enrollment_modules where enrollment_id = :'enrollment_a'::uuid) = 2,
  'approval snapshots only the modules published at approval time');

select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}', false);
select harness.expect_error(
  'select public.create_order(''logistics-101'')',
  'already has access',
  'an enrolled student cannot order and pay a second time');
select set_config('request.jwt.claims', '{"sub":"99999999-9999-4999-8999-999999999999","role":"authenticated"}', false);

select public.review_payment(:'sub_a', 'approved', null) as enrollment_a_again \gset
select public.review_payment(:'sub_a', 'rejected', 'late duplicate review') as enrollment_a_third \gset

select harness.check(
  (:'enrollment_a_again'::text = :'enrollment_a'::text)
  and (:'enrollment_a_third'::text = :'enrollment_a'::text)
  and (select status from public.payment_submissions where id = :'sub_a') = 'approved'
  and (select count(*) from public.enrollment_grants where enrollment_id = :'enrollment_a'::uuid) = 1
  and (select count(*) from public.email_outbox where idempotency_key = 'enrollment-approved:' || :'sub_a') = 1,
  'repeated approval and a late rejection cannot duplicate or revoke access');

select public.grant_manual_enrollment('22222222-2222-4222-8222-222222222222', :'course_id', 'complimentary', 'test complimentary grant') as enrollment_b \gset

select harness.check(
  (select count(*) from public.enrollment_grants where enrollment_id = :'enrollment_b'::uuid and source_type = 'manual') = 1
  and (select count(*) from public.payment_submissions where status = 'approved' and order_id = :'order_b_id') = 0
  and (select count(*) from public.audit_logs where action = 'enrollment.manual_grant') = 1,
  'manual enrollment is audited and never fabricates an approved payment');

select public.review_payment(:'sub_b', 'resubmission_required', 'receipt image is unreadable') as enrollment_b_resubmit \gset
select harness.check(
  (select status from public.payment_submissions where id = :'sub_b') = 'resubmission_required'
  and (select review_reason from public.payment_submissions where id = :'sub_b') = 'receipt image is unreadable',
  'an admin can request resubmission with a visible reason');

select public.review_payment(:'sub_b', 'rejected', 'unreadable and resubmission window closed') as enrollment_b_reject \gset
select harness.check(
  (select status from public.enrollments where id = :'enrollment_b'::uuid) = 'active',
  'rejecting a duplicate submission never removes an existing valid enrollment');

select public.set_enrollment_access(:'enrollment_a', 'suspended', 'test suspension');
select public.set_enrollment_access(:'enrollment_a', 'active', 'test reinstatement');
select public.set_account_status('33333333-3333-4333-8333-333333333333', 'suspended', 'test account suspension') \gset

select harness.check(
  (select count(*) from public.audit_logs where action in ('enrollment.suspended','enrollment.active','account.suspended')) = 3,
  'access changes are audited with reasons');

select harness.expect_error(
  format('select public.set_enrollment_access(%L, ''revoked'', ''x'')', :'enrollment_a'),
  'reason is required',
  'a reason shorter than three characters cannot change access');

select harness.check(
  (select status from public.enrollments where id = :'enrollment_a'::uuid) = 'active',
  'a refused access change leaves enrollment state untouched');
reset role;

-- Proof revisions are only accepted by the storage Edge Function path.
select harness.expect_error(
  format('select public.add_payment_proof_revision(''22222222-2222-4222-8222-222222222222'', %L, (select id from public.payment_methods where enabled), 69900, ''R'', now(), ''22222222-2222-4222-8222-222222222222/%s/x.png'', ''x.png'', ''image/png'', 10, %L)', :'sub_b', :'order_b_id', repeat('f', 64)),
  'resubmission-requested',
  'corrected proof is refused unless a resubmission was requested');

select public.create_payment_resubmission(
  '22222222-2222-4222-8222-222222222222', :'order_b_id',
  (select id from public.payment_methods where enabled),
  69900, 'REF-B-002', now(),
  '22222222-2222-4222-8222-222222222222/' || :'order_b_id' || '/proof2.png',
  'proof2.png', 'image/png', 2048, repeat('f', 64)
) as sub_b2 \gset

set role authenticated;
select set_config('request.jwt.claims', '{"sub":"99999999-9999-4999-8999-999999999999","role":"authenticated"}', false);
select public.review_payment(:'sub_b2', 'resubmission_required', 'second attempt also unclear');
reset role;

select harness.expect_error(
  format('select public.add_payment_proof_revision(''22222222-2222-4222-8222-222222222222'', %L, (select id from public.payment_methods where enabled), 1, ''REF-B-TAMPERED'', now(), ''22222222-2222-4222-8222-222222222222/%s/tampered.png'', ''tampered.png'', ''image/png'', 10, %L)', :'sub_b2', :'order_b_id', repeat('b', 64)),
  'must match the order amount',
  'a corrected proof cannot replace the authoritative order amount');

select harness.expect_error(
  format('select public.add_payment_proof_revision(''22222222-2222-4222-8222-222222222222'', %L, (select id from public.payment_methods where enabled), 69900, ''REF-B-TAMPERED'', now(), ''11111111-1111-4111-8111-111111111111/%s/tampered.png'', ''tampered.png'', ''image/png'', 10, %L)', :'sub_b2', :'order_b_id', repeat('b', 64)),
  'Invalid proof ownership path',
  'a corrected proof cannot use another student storage prefix');

select harness.check(
  (select status from public.payment_submissions where id = :'sub_b2') = 'resubmission_required'
  and (select count(*) from public.payment_proof_revisions where submission_id = :'sub_b2') = 1,
  'refused corrected proofs leave payment state and evidence unchanged');

select public.add_payment_proof_revision(
  '22222222-2222-4222-8222-222222222222', :'sub_b2',
  (select id from public.payment_methods where enabled),
  69900, 'REF-B-003', now(),
  '22222222-2222-4222-8222-222222222222/' || :'order_b_id' || '/proof3.png',
  'proof3.pdf', 'application/pdf', 4096, repeat('a', 64)
) as sub_b2_revised \gset

select harness.check(
  (select status from public.payment_submissions where id = :'sub_b') = 'rejected'
  and (select reviewer_id from public.payment_submissions where id = :'sub_b') = '99999999-9999-4999-8999-999999999999'
  and (select count(*) from public.payment_proof_revisions where submission_id = :'sub_b') = 1,
  'a rejected submission keeps its reviewer and original evidence');

select harness.check(
  (select status from public.payment_submissions where id = :'sub_b2') = 'pending'
  and (select count(*) from public.payment_proof_revisions where submission_id = :'sub_b2') = 2
  and (select max(revision) from public.payment_proof_revisions where submission_id = :'sub_b2') = 2
  and (select count(*) from public.payment_events where submission_id = :'sub_b2') >= 2,
  'a reopened case returns to pending with immutable revision and event history');

-- ---------------------------------------------------------------------------
-- Learning, progress, and trusted scoring
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}', false);

select harness.expect_error(
  format('select public.start_quiz_attempt(''a1111111-1111-4111-8111-111111111111'', ''ceb'')'),
  'No published quiz version',
  'a missing language version is reported instead of silently substituted');

select public.mark_module_studied(:'module_one');
select * from public.enrollment_progress(:'enrollment_a') \gset

select harness.check(
  :'required_total' = '2' and :'required_complete' = '0' and :'final_unlocked' = 'f',
  'an unfinished module leaves the final quiz locked');

select harness.check(
  (select count(*) from public.module_progress where enrollment_id = :'enrollment_a'::uuid and studied_at is not null) = 1,
  'marking a lesson studied is recorded server-side');

select public.start_quiz_attempt('a1111111-1111-4111-8111-111111111111', 'en') as kc_attempt_one \gset

select harness.expect_error(
  'select public.start_quiz_attempt(''a1111111-1111-4111-8111-111111111111'', ''en'')',
  'already in progress',
  'a second concurrent attempt is refused');

select harness.check(
  not exists (
    select 1 from jsonb_array_elements(public.quiz_payload(:'kc_attempt_one') -> 'questions') question
    where question ? 'correct' or question ? 'correctOptionId' or question ? 'answerKey'
  ),
  'the attempt payload exposes no answer key fields');

select harness.expect_error(
  format('select public.quiz_payload(%L)', :'enrollment_a'),
  'Attempt not found',
  'attempt payloads cannot be fetched by enrollment id');

select public.submit_quiz_attempt(:'kc_attempt_one',
  jsonb_build_array(
    jsonb_build_object('questionId','c1111111-1111-4111-8111-111111111111','optionId',to_jsonb(:'key_kc_one'::uuid)),
    jsonb_build_object('questionId','c1111111-1111-4111-8111-111111111112','optionId',(select o.id from public.question_options o where o.question_id = 'c1111111-1111-4111-8111-111111111112' and o.position = 2), 'score', 100, 'passed', true)
  )) as kc_result \gset

select harness.check(
  (:'kc_result'::json ->> 'score')::numeric = '50.00'
  and (:'kc_result'::json ->> 'passed') is null,
  'a forged score and pass flag in the browser payload have no effect');

select harness.check(
  (select count(*) from public.module_progress where enrollment_id = :'enrollment_a'::uuid and completed_at is not null) = 1,
  'studied plus knowledge check completion marks the module complete');

select public.submit_quiz_attempt(:'kc_attempt_one', '[]'::jsonb) as kc_result_again \gset
select harness.check(
  (:'kc_result_again'::json ->> 'alreadyScored') = 'true'
  and (select state from public.quiz_attempts where id = :'kc_attempt_one') = 'scored',
  'resubmitting a scored attempt is idempotent');

select public.start_quiz_attempt('a1111111-1111-4111-8111-111111111111', 'en') as kc_attempt_two \gset
select harness.check(
  (select attempt_number from public.quiz_attempts where id = :'kc_attempt_two') = 2,
  'knowledge checks may be repeated');

select harness.expect_error(
  'select public.start_quiz_attempt(''b2222222-2222-4222-8222-222222222222'', ''en'')',
  'Complete all required modules',
  'the final quiz cannot start before every required module is complete');

select public.mark_module_studied(:'module_two');
select public.start_quiz_attempt('a1111111-1111-4111-8111-111111111113', 'en') as kc_attempt_three \gset
select public.submit_quiz_attempt(:'kc_attempt_three',
  jsonb_build_array(jsonb_build_object('questionId','e1111111-1111-4111-8111-111111111111','optionId',to_jsonb(:'key_kc_two'::uuid)))
) as kc_result_three \gset

select * from public.enrollment_progress(:'enrollment_a') \gset
select harness.check(
  :'required_complete' = '2' and :'final_unlocked' = 't',
  'server progress unlocks the final quiz only when all required modules are complete');

select public.start_quiz_attempt('b2222222-2222-4222-8222-222222222222', 'en') as final_one \gset
select public.submit_quiz_attempt(:'final_one',
  jsonb_build_array(
    jsonb_build_object('questionId','d2222222-2222-4222-8222-222222222221','optionId',to_jsonb(:'key_final_one'::uuid)),
    jsonb_build_object('questionId','d2222222-2222-4222-8222-222222222222','optionId',to_jsonb(:'key_final_two'::uuid)),
    jsonb_build_object('questionId','d2222222-2222-4222-8222-222222222223','optionId',to_jsonb(:'key_final_three'::uuid)),
    jsonb_build_object('questionId','d2222222-2222-4222-8222-222222222224','optionId',(select o.id from public.question_options o where o.question_id = 'd2222222-2222-4222-8222-222222222224' and o.position = 2))
  )) as final_one_result \gset

select harness.check(
  (:'final_one_result'::json ->> 'score')::numeric = '75.00'
  and (:'final_one_result'::json ->> 'passed') = 'true',
  'exactly 75 percent passes the final quiz');

select public.start_quiz_attempt('b2222222-2222-4222-8222-222222222222', 'en') as final_two \gset
select public.submit_quiz_attempt(:'final_two',
  jsonb_build_array(
    jsonb_build_object(
      'questionId','d2222222-2222-4222-8222-222222222221',
      'optionId',to_jsonb(:'key_final_one'::uuid),
      'score', 100, 'passed', true, 'is_correct', true),
    jsonb_build_object('questionId','d2222222-2222-4222-8222-222222222222','optionId',(select o.id from public.question_options o where o.question_id = 'd2222222-2222-4222-8222-222222222222' and o.position = 3)),
    jsonb_build_object('questionId','d2222222-2222-4222-8222-222222222223','optionId',(select o.id from public.question_options o where o.question_id = 'd2222222-2222-4222-8222-222222222223' and o.position = 4)),
    jsonb_build_object('questionId','d2222222-2222-4222-8222-222222222224','optionId',(select o.id from public.question_options o where o.question_id = 'd2222222-2222-4222-8222-222222222224' and o.position = 4))
  )) as final_two_result \gset

select harness.check(
  (:'final_two_result'::json ->> 'score')::numeric = '25.00'
  and (:'final_two_result'::json ->> 'passed') = 'false',
  'a wrong-answer final attempt fails even with forged pass fields');

select public.start_quiz_attempt('b2222222-2222-4222-8222-222222222222', 'en') as final_three \gset
select harness.check(
  (select attempt_number from public.quiz_attempts where id = :'final_three') = 3,
  'attempt numbering is per enrollment and quiz, not per language');

select public.submit_quiz_attempt(:'final_three',
  jsonb_build_array(
    jsonb_build_object('questionId','d2222222-2222-4222-8222-222222222221','optionId',(select o.id from public.question_options o where o.question_id = 'd2222222-2222-4222-8222-222222222221' and o.position = 2)),
    jsonb_build_object('questionId','d2222222-2222-4222-8222-222222222222','optionId',(select o.id from public.question_options o where o.question_id = 'd2222222-2222-4222-8222-222222222222' and o.position = 3)),
    jsonb_build_object('questionId','d2222222-2222-4222-8222-222222222223','optionId',(select o.id from public.question_options o where o.question_id = 'd2222222-2222-4222-8222-222222222223' and o.position = 4)),
    jsonb_build_object('questionId','d2222222-2222-4222-8222-222222222224','optionId',(select o.id from public.question_options o where o.question_id = 'd2222222-2222-4222-8222-222222222224' and o.position = 4))
  )) as final_three_result \gset

select harness.check(
  (select state from public.quiz_attempts where id = :'final_three') = 'scored'
  and (select count(*) from public.quiz_attempts where quiz_id = 'b2222222-2222-4222-8222-222222222222' and state = 'in_progress') = 0,
  'a scored attempt does not stay open and block the next one');

select harness.expect_error(
  'select public.start_quiz_attempt(''b2222222-2222-4222-8222-222222222222'', ''en'')',
  'Attempt limit reached',
  'the server enforced attempt limit stops a fourth attempt');

select harness.expect_error(
  format('select public.quiz_payload(%L)', :'enrollment_a'),
  'Attempt not found',
  'attempt payloads cannot be fetched by enrollment id');
reset role;

update public.quiz_versions set max_attempts = null, cooldown_hours = 24 where id = 'b2222222-2222-4222-8222-222222222223';
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}', false);
select harness.expect_error(
  'select public.start_quiz_attempt(''b2222222-2222-4222-8222-222222222222'', ''en'')',
  'waiting period',
  'a configured cooldown blocks an immediate retry');
reset role;

set role authenticated;
select set_config('request.jwt.claims', '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}', false);
select harness.check(
  (select count(*) from public.quiz_attempts) = 0
  and (select count(*) from public.module_progress) = 0
  and (select count(*) from public.enrollment_modules) = 2,
  'a second student sees none of the first student attempts or progress');
reset role;

-- ---------------------------------------------------------------------------
-- Curriculum snapshots stay stable unless an admin opts in
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"99999999-9999-4999-8999-999999999999","role":"authenticated"}', false);
select id as module_four from public.modules where course_id = :'course_id' and position = 4 \gset
select public.admin_save_module(:'course_id', 4, true, :'module_four');
select public.admin_set_module_status(:'module_four', 'published', 'late curriculum addition');
select harness.check(
  (select count(*) from public.enrollment_modules where enrollment_id = :'enrollment_a'::uuid) = 2,
  'publishing a new module does not silently change existing enrollment snapshots');

select harness.expect_error(
  format('select public.admin_add_module_to_enrollments(%L, ''ok'')', :'module_four'),
  'reason is required',
  'adding a module to existing enrollments requires a reason');

select public.admin_add_module_to_enrollments(:'module_four', 'new unit released to current students') as module_four_fanout \gset
select harness.check(
  :'module_four_fanout' = '2'
  and (select count(*) from public.enrollment_modules where enrollment_id = :'enrollment_a'::uuid) = 3
  and (select count(*) from public.audit_logs where action = 'module.added_to_enrollments') = 1,
  'an explicit opt-in adds the module to active enrollments and is audited');

select public.admin_set_module_status(:'module_four', 'archived', 'typo in the material');
select harness.check(
  (select status from public.modules where id = :'module_four') = 'archived'
  and (select count(*) from public.enrollment_modules where enrollment_id = :'enrollment_a'::uuid) = 3,
  'archiving a module preserves existing snapshots instead of deleting access');
reset role;

-- ---------------------------------------------------------------------------
-- Entitlement-checked material access (Edge Function database surface)
--
-- The course-material-access function resolves the caller from its bearer token
-- and passes that id here. These assertions prove the SQL refuses what the
-- function must not sign a link for. Signing the returned path through the
-- Storage API is a hosted check and stays NOT RUN.

select public.issue_material_access(
  '11111111-1111-4111-8111-111111111111', :'module_one', 'en') as material_en \gset
select harness.check(
  :'material_en'::jsonb ->> 'language' = 'en'
  and :'material_en'::jsonb ->> 'fallback' = 'false'
  and :'material_en'::jsonb ->> 'objectPath' = 'course-materials/m1/en/v1.pdf',
  'an enrolled student in their own language receives the intended object');

select public.issue_material_access(
  '11111111-1111-4111-8111-111111111111', :'module_one', 'ceb') as material_ceb \gset
select harness.check(
  :'material_ceb'::jsonb ->> 'language' = 'ceb'
  and :'material_ceb'::jsonb ->> 'objectPath' = 'course-materials/m1/ceb/v1.pdf',
  'the Bisaya version is served when it exists');

-- Module two has English only, so a Bisaya request must be labelled as a
-- fallback rather than silently passing English off as Bisaya.
select public.issue_material_access(
  '11111111-1111-4111-8111-111111111111', :'module_two', 'ceb') as material_fallback \gset
select harness.check(
  :'material_fallback'::jsonb ->> 'language' = 'en'
  and :'material_fallback'::jsonb ->> 'fallback' = 'true'
  and :'material_fallback'::jsonb ->> 'requestedLanguage' = 'ceb',
  'a missing translation is served as an explicitly labelled fallback');

-- Student B holds a complimentary manual grant in this fixture, so an account
-- with genuinely no enrollment is asserted separately below.
select harness.check(
  (select count(*) from public.enrollments where user_id = '22222222-2222-4222-8222-222222222222' and status = 'active') = 1,
  'the manually granted second student does hold an active enrollment');

select public.issue_material_access(
  '22222222-2222-4222-8222-222222222222', :'module_one', 'en') as material_manual_grant \gset
select harness.check(
  :'material_manual_grant'::jsonb ->> 'language' = 'en',
  'a complimentary manual grant receives material like any other active enrollment');

-- Refusals come back as a recorded decision rather than a raised error, so the
-- assertions inspect the returned payload.
select public.issue_material_access(
  '44444444-4444-4444-8444-444444444444', :'module_one', 'en') as denied_no_enrollment \gset
select harness.check(
  :'denied_no_enrollment'::jsonb ->> 'allowed' = 'false'
  and :'denied_no_enrollment'::jsonb ->> 'error' like '%active enrollment is required%',
  'a registered student with no enrollment cannot obtain a material link');

select public.issue_material_access(
  '33333333-3333-4333-8333-333333333333', :'module_one', 'en') as denied_suspended \gset
select harness.check(
  :'denied_suspended'::jsonb ->> 'allowed' = 'false',
  'a suspended account with an old session is refused at the database');

-- module_three stayed a draft and was never added to any snapshot.
select public.issue_material_access(
  '11111111-1111-4111-8111-111111111111', :'module_three', 'en') as denied_outside \gset
select harness.check(
  :'denied_outside'::jsonb ->> 'allowed' = 'false'
  and :'denied_outside'::jsonb ->> 'error' like '%not part of your curriculum%',
  'a module outside the enrollment snapshot is refused even for a paying student');

-- module_four is in the snapshot but was archived afterwards.
select public.issue_material_access(
  '11111111-1111-4111-8111-111111111111', :'module_four', 'en') as denied_archived \gset
select harness.check(
  :'denied_archived'::jsonb ->> 'allowed' = 'false'
  and :'denied_archived'::jsonb ->> 'error' like '%not published%',
  'an archived module cannot serve a new link even though the snapshot still lists it');

select harness.check(
  (select count(*) from public.material_access_events where user_id = '44444444-4444-4444-8444-444444444444' and event_type = 'access_denied') = 1
  and (select count(*) from public.material_access_events where user_id = '33333333-3333-4333-8333-333333333333' and event_type = 'access_denied') = 1
  and (select count(*) from public.material_access_events where user_id = '11111111-1111-4111-8111-111111111111' and event_type = 'access_denied') = 2,
  'refusals are recorded as access_denied for refund and support review');

select harness.check(
  (select count(*) from public.material_access_events where event_type = 'link_issued')
  = (select count(*) from public.material_access_events
     where event_type = 'link_issued' and object_path <> ''),
  'every issuance event records the object path that was actually served');

-- Language preference is persisted and drives the default, without creating a
-- second enrollment or resetting progress.
select public.issue_material_access(
  '11111111-1111-4111-8111-111111111111', :'module_one', null) as material_preference \gset
select harness.check(
  :'material_preference'::jsonb ->> 'language' = 'en'
  and :'material_preference'::jsonb ->> 'requestedLanguage' = 'en'
  and (select count(*) from public.enrollments where user_id = '11111111-1111-4111-8111-111111111111') = 1
  and (select count(*) from public.module_progress where enrollment_id = :'enrollment_a'::uuid and studied_at is not null) = 2
  and (select count(*) from public.module_progress where enrollment_id = :'enrollment_a'::uuid and completed_at is not null) >= 1,
  'with no language requested the stored preference is used without creating an enrollment or resetting recorded progress');

set role authenticated;
select harness.expect_error(
  format('select public.issue_material_access(%L, %L, %L)',
    '11111111-1111-4111-8111-111111111111', :'module_one', 'en'),
  'permission denied',
  'the frontend role cannot call the entitlement check directly');
reset role;

-- The row-level policy filters to zero rows rather than raising, so the correct
-- expectation is an empty result, not a privilege error. Confirmed as the
-- harness superuser first, so the zero-row result below cannot pass merely
-- because the fixture is empty.
select harness.check(
  (select count(*) from public.material_access_events where user_id = '22222222-2222-4222-8222-222222222222') >= 1,
  'the fixture really does contain another student material access history');

set role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}', false);
select harness.expect_no_rows(
  'select * from public.material_access_events where user_id = ''22222222-2222-4222-8222-222222222222''',
  'a student cannot read another student material access history');
reset role;

-- ---------------------------------------------------------------------------
-- Material authoring replaces files without destroying history
--
-- The submit-course-material function holds the service role and passes the
-- caller's admin-checked id. The assertions run under that same role, because
-- the frontend role has no execute grant at all.
set role service_role;

select public.admin_save_module_translation(
  '99999999-9999-4999-8999-999999999999', :'module_one', 'ceb',
  'Fundamentals sa Logistics (revised)', 'Replacement lesson',
  'course-materials/m1/ceb/v2.pdf', repeat('d', 64), 2048, false) as replacement \gset
select harness.check(
  :'replacement'::jsonb ->> 'version' = '2'
  and (select count(*) from public.module_translations where module_id = :'module_one' and language = 'ceb') = 2,
  'a replacement creates a new immutable version and keeps the previous one');

select harness.check(
  (select count(*) from public.module_translations mt
   where mt.module_id = :'module_one' and mt.language = 'ceb' and mt.published) = 1
  and (select published from public.module_translations where id = (:'replacement'::jsonb ->> 'translationId')::uuid) = false,
  'an unpublished replacement does not displace the live student-facing version');

select public.admin_set_translation_published(
  '99999999-9999-4999-8999-999999999999', (:'replacement'::jsonb ->> 'translationId')::uuid, true,
  'trainer approved the revised Bisaya lesson');
select public.issue_material_access(
  '11111111-1111-4111-8111-111111111111', :'module_one', 'ceb') as material_v2 \gset
select harness.check(
  :'material_v2'::jsonb ->> 'version' = '2'
  and :'material_v2'::jsonb ->> 'objectPath' = 'course-materials/m1/ceb/v2.pdf',
  'students receive the newly published version while the old one is retained');

select harness.expect_error(
  format('select public.admin_save_module_translation(%L, %L, %L, %L, %L, %L, %L, %L, %L)',
    '11111111-1111-4111-8111-111111111111', :'module_one', 'ceb', 'X', '', 'p.pdf', repeat('e', 64), 1024, false),
  'Administrator role required',
  'the service role cannot publish material on behalf of a non-admin caller');

select harness.expect_error(
  format('select public.admin_save_module_translation(%L, %L, %L, %L, %L, %L, %L, %L, %L)',
    '99999999-9999-4999-8999-999999999999', :'module_one', 'en', 'X', '', 'p.pdf', repeat('e', 64), 60000000, false),
  '50 MB or less',
  'oversized material is refused at the database');

select harness.expect_error(
  format('select public.admin_save_module_translation(%L, %L, %L, %L, %L, %L, %L, %L, %L)',
    '99999999-9999-4999-8999-999999999999', :'module_one', 'en', 'X', '', 'p.pdf', 'short', 1024, false),
  'content hash are required',
  'material without a verifiable content hash is refused');
reset role;

set role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}', false);
select harness.expect_error(
  format('select public.admin_save_module_translation(%L, %L, %L, %L, %L, %L, %L, %L, %L)',
    '11111111-1111-4111-8111-111111111111', :'module_one', 'en', 'Mine', '', 'p.pdf', repeat('f', 64), 1024, true),
  'permission denied',
  'a student cannot call the material authoring operation at all');
reset role;

-- ---------------------------------------------------------------------------
-- Material entitlement refuses malformed input without losing the audit trail
--
-- An unsupported language used to reach the enum cast directly. That raised an
-- exception, which rolled back the very access_denied row support relies on. The
-- fix validates the string first, so the refusal is recorded like any other.
set role service_role;
select public.issue_material_access(
  '11111111-1111-4111-8111-111111111111', :'module_one', 'fr') as bad_language \gset
select harness.check(
  :'bad_language'::jsonb ->> 'allowed' = 'false'
  and :'bad_language'::jsonb ->> 'error' = 'Unsupported language',
  'an unsupported language is refused instead of crashing on the enum cast');

select harness.check(
  (select count(*) from public.material_access_events
   where user_id = '11111111-1111-4111-8111-111111111111'
     and event_type = 'access_denied') >= 1,
  'the malformed language refusal is still recorded for support review');

-- The same file uploaded twice must not collide on the unique object_path, so a
-- retry after a dropped response is safe.
select public.admin_save_module_translation(
  '99999999-9999-4999-8999-999999999999', :'module_one', 'ceb',
  'Fundamentals sa Logistics (revised)', 'Replacement lesson',
  'course-materials/m1/ceb/v2.pdf', repeat('d', 64), 2048, false) as identical_reupload \gset
select harness.check(
  :'identical_reupload'::jsonb ->> 'unchanged' = 'true'
  and :'identical_reupload'::jsonb ->> 'translationId' = :'replacement'::jsonb ->> 'translationId'
  and :'identical_reupload'::jsonb ->> 'version' = :'replacement'::jsonb ->> 'version',
  're-uploading the identical file returns the existing version instead of failing');

select harness.check(
  (select count(*) from public.module_translations where module_id = :'module_one' and language = 'ceb') = 2,
  'an identical re-upload does not create a duplicate version');

-- A different file with the same language must still advance the version, which
-- proves the idempotent path did not swallow legitimate changes.
select public.admin_save_module_translation(
  '99999999-9999-4999-8999-999999999999', :'module_one', 'ceb',
  'Fundamentals sa Logistics (revised again)', 'Second replacement lesson',
  'course-materials/m1/ceb/v3.pdf', repeat('c', 64), 3072, false) as second_replacement \gset
select harness.check(
  :'second_replacement'::jsonb ->> 'version' = '3'
  and :'second_replacement'::jsonb ->> 'unchanged' = 'false',
  'a genuinely different file still creates the next version');
reset role;

-- ---------------------------------------------------------------------------
-- Certificate eligibility, generation leases, privacy, and verification
select harness.check(
  (select public = false and allowed_mime_types @> array['image/png']::text[] from storage.buckets where id = 'certificate-templates')
  and (select template_version = 2
       and template_object_path = 'logistics-101/v2/background.png'
       and template_sha256 = '0ae273c023f8237fa990115257b21ef208637ba29b3d309b2b5e67cd039d9062'
       from public.course_certificate_configs where course_id = :'course_id'),
  'certificate generation uses the integrity-pinned private background template');
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}', false);
select harness.expect_error(
  format('select public.ensure_certificate(%L)', :'enrollment_a'),
  'Certificate issuance is not enabled',
  'certificate issuance remains disabled while the real curriculum is incomplete');
reset role;

update public.course_certificate_configs set enabled = true where course_id = :'course_id';
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}', false);
select harness.expect_error(
  format('select public.ensure_certificate(%L)', :'enrollment_a'),
  'does not contain the required certificate curriculum',
  'a partial enrollment snapshot cannot satisfy the configured eight-module certificate');
reset role;

insert into public.modules (course_id, position, required, status)
select :'course_id', position, true, 'published'
from generate_series(101, 105) position;
insert into public.enrollment_modules (enrollment_id, module_id, required, curriculum_version)
select :'enrollment_a', id, true, curriculum_version
from public.modules where course_id = :'course_id' and position between 101 and 105;
insert into public.module_progress (enrollment_id, module_id, studied_at, knowledge_check_completed_at, completed_at)
select :'enrollment_a', em.module_id, now(), now(), now()
from public.enrollment_modules em
where em.enrollment_id = :'enrollment_a'
on conflict (enrollment_id, module_id) do update
set studied_at = coalesce(public.module_progress.studied_at, excluded.studied_at),
    knowledge_check_completed_at = coalesce(public.module_progress.knowledge_check_completed_at, excluded.knowledge_check_completed_at),
    completed_at = coalesce(public.module_progress.completed_at, excluded.completed_at);

set role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}', false);
select (public.ensure_certificate(:'enrollment_a')).id as certificate_a \gset
select (public.ensure_certificate(:'enrollment_a')).id as certificate_a_retry \gset
select harness.check(
  :'certificate_a' = :'certificate_a_retry'
  and (select count(*) from public.certificates where enrollment_id = :'enrollment_a') = 1
  and (select final_score from public.certificates where id = :'certificate_a') = 75.00,
  'exactly 75 percent is eligible and repeated issuance returns one certificate');
select harness.expect_error(
  format('select public.ensure_certificate(%L)', :'enrollment_b'),
  'Access denied',
  'a student cannot issue a certificate for another enrollment');
reset role;

update public.profiles set full_name = 'Student A Updated' where id = '11111111-1111-4111-8111-111111111111';
select harness.check(
  (select student_name from public.certificates where id = :'certificate_a') = 'Student A',
  'certificate identity is snapshotted and does not change with later profile edits');

set role authenticated;
select set_config('request.jwt.claims', '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}', false);
select harness.expect_no_rows(
  format('select * from public.certificates where id = %L', :'certificate_a'),
  'another student cannot read certificate issuance evidence');
reset role;

set role service_role;
select gen_random_uuid() as certificate_worker_token \gset
select public.claim_certificate_generation(:'certificate_a', :'certificate_worker_token') as certificate_claim \gset
select harness.check(
  (:'certificate_claim'::jsonb ->> 'claimed')::boolean
  and :'certificate_claim'::jsonb ->> 'studentName' = 'Student A',
  'the service worker obtains a bounded generation lease and immutable snapshots');
select (public.complete_certificate_generation(
  :'certificate_a', :'certificate_worker_token',
  'course/test/certificate.pdf', repeat('a', 64), 4096
)).verification_id as certificate_verification_id \gset
select harness.check(
  (select status from public.certificates where id = :'certificate_a') = 'active'
  and (select count(*) from public.email_outbox where idempotency_key = 'certificate-ready:' || :'certificate_a') = 1,
  'generation completion activates one private certificate and queues one notification');
select public.issue_certificate_access('11111111-1111-4111-8111-111111111111', :'certificate_a') as certificate_access \gset
select public.issue_certificate_access('22222222-2222-4222-8222-222222222222', :'certificate_a') as certificate_denied \gset
select harness.check(
  :'certificate_access'::jsonb ->> 'allowed' = 'true'
  and :'certificate_access'::jsonb ->> 'objectPath' = 'course/test/certificate.pdf'
  and :'certificate_denied'::jsonb ->> 'allowed' = 'false',
  'only the certificate owner or an administrator receives the server-owned private path');
select public.verify_certificate_record(:'certificate_verification_id') as certificate_public \gset
select harness.check(
  :'certificate_public'::jsonb ->> 'status' = 'valid'
  and :'certificate_public'::jsonb ->> 'studentName' = 'Student A'
  and not (:'certificate_public'::jsonb ? 'userId')
  and not (:'certificate_public'::jsonb ? 'finalScore')
  and not (:'certificate_public'::jsonb ? 'objectPath'),
  'public verification exposes validity and snapshots without private evidence');
select public.check_certificate_rate_limit('test-hashed-request-key') as certificate_rate_allowed \gset
reset role;
select harness.check(
  :'certificate_rate_allowed'::boolean
  and (select count(*) from private.certificate_verification_limits where request_key = 'test-hashed-request-key') = 1,
  'verification rate limiting stores only the supplied one-way request key');

-- ---------------------------------------------------------------------------
-- Completed external refund reconciliation and financial ledger
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"99999999-9999-4999-8999-999999999999","role":"authenticated"}', false);
select harness.expect_error(
  format(
    'select public.record_completed_refund(%L, 69900, ''EXT-NOT-APPROVED'', now(), ''test refusal'', false)',
    :'sub_d'),
  'Only an approved payment',
  'an unapproved payment cannot be reconciled as refunded');
select (public.record_completed_refund(
  :'sub_a', 69900, 'EXT-REFUND-001', now(), 'verified external test refund', false
)).id as refund_a \gset
select (public.record_completed_refund(
  :'sub_a', 69900, 'EXT-REFUND-001', now(), 'idempotent retry', false
)).id as refund_a_retry \gset
select harness.check(
  :'refund_a' = :'refund_a_retry'
  and (select status from public.payment_submissions where id = :'sub_a') = 'refunded'
  and (select count(*) from public.refunds where submission_id = :'sub_a') = 1
  and (select count(*) from public.email_outbox where idempotency_key = 'refund-completed:' || :'refund_a') = 1,
  'completed refund reconciliation is idempotent and records one ledger source and notification');
select harness.check(
  (select status from public.enrollments where id = :'enrollment_a') = 'active'
  and (select status from public.certificates where id = :'certificate_a') = 'active',
  'refund reconciliation retains access and certificate without an approved revocation decision');
select sum(gross_centavos) as ledger_gross,
       sum(refund_centavos) as ledger_refunds,
       sum(net_centavos) as ledger_net,
       count(*) as ledger_events
from public.admin_financial_ledger(
  (now() at time zone 'Asia/Manila')::date,
  (now() at time zone 'Asia/Manila')::date
) where submission_id = :'sub_a' \gset
select harness.check(
  :'ledger_gross' = '69900' and :'ledger_refunds' = '69900'
  and :'ledger_net' = '0' and :'ledger_events' = '2',
  'the ledger preserves original gross and records the refund as a separate negative event');
reset role;

set role authenticated;
select set_config('request.jwt.claims', '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}', false);
select harness.expect_no_rows(
  'select * from public.refunds',
  'students cannot read refund reconciliation records');
select harness.expect_error(
  format(
    'select public.record_completed_refund(%L, 69900, ''EXT-FORGED'', now(), ''forged refund'', false)',
    :'sub_b'),
  'Administrator role required',
  'students cannot record a completed external refund');
reset role;

-- ---------------------------------------------------------------------------
-- Email outbox leasing, retry, and terminal failure
update public.email_outbox set next_attempt_at = now() + interval '1 day' where status = 'queued';
insert into public.email_outbox (idempotency_key, template, recipient_user_id, payload)
values ('worker-test-retry', 'enrollment_approved', '11111111-1111-4111-8111-111111111111', '{}')
returning id as retry_outbox_id \gset

set role service_role;
select * from public.claim_email_outbox('test-worker', 1) \gset email_first_
select harness.check(
  :'email_first_id' = :'retry_outbox_id' and :'email_first_attempt' = '1',
  'the worker atomically claims one due outbox row with a lease');
select harness.expect_error(
  format('select public.mark_email_sent(%L, %L, ''forged'')', :'retry_outbox_id', gen_random_uuid()),
  'lease is invalid',
  'a worker cannot finalize an email with another lease token');
select public.mark_email_failed(:'retry_outbox_id', :'email_first_lock_token', 'temporary provider outage', true);
reset role;
update public.email_outbox set next_attempt_at = now() where id = :'retry_outbox_id';

set role service_role;
select * from public.claim_email_outbox('test-worker', 1) \gset email_second_
select public.mark_email_sent(:'retry_outbox_id', :'email_second_lock_token', 'provider-message-1');
reset role;
select harness.check(
  (select status from public.email_outbox where id = :'retry_outbox_id') = 'sent'
  and (select attempts from public.email_outbox where id = :'retry_outbox_id') = 2
  and (select count(*) from public.email_delivery_events where outbox_id = :'retry_outbox_id') = 4,
  'a transient provider failure is retried and then recorded as sent exactly once');

insert into public.email_outbox (idempotency_key, template, recipient_user_id, payload)
values ('worker-test-terminal', 'enrollment_approved', '11111111-1111-4111-8111-111111111111', '{}')
returning id as terminal_outbox_id \gset
set role service_role;
select * from public.claim_email_outbox('test-worker', 1) \gset email_terminal_
select public.mark_email_failed(:'terminal_outbox_id', :'email_terminal_lock_token', 'invalid verified sender', false);
reset role;
select harness.check(
  (select status from public.email_outbox where id = :'terminal_outbox_id') = 'failed'
  and (select failed_at from public.email_outbox where id = :'terminal_outbox_id') is not null,
  'a permanent provider failure reaches a terminal state and is not reported as sent');

insert into public.email_outbox (
  idempotency_key, template, recipient_user_id, payload, status, attempts,
  locked_at, lock_token, lease_until
)
values (
  'worker-test-expired-final-lease', 'enrollment_approved',
  '11111111-1111-4111-8111-111111111111', '{}', 'sending', 5,
  now() - interval '10 minutes', gen_random_uuid(), now() - interval '5 minutes'
)
returning id as expired_final_outbox_id \gset
set role service_role;
select count(*) from public.claim_email_outbox('test-worker', 50);
reset role;
select harness.check(
  (select status from public.email_outbox where id = :'expired_final_outbox_id') = 'failed'
  and (select attempts from public.email_outbox where id = :'expired_final_outbox_id') = 5
  and (select count(*) from public.email_delivery_events where outbox_id = :'expired_final_outbox_id' and event_type = 'failed') = 1,
  'an expired final-attempt lease is failed without an unbounded sixth claim');

update public.profiles
set account_status = 'suspended'
where id = '99999999-9999-4999-8999-999999999999';

set role authenticated;
select set_config('request.jwt.claims', '{"sub":"99999999-9999-4999-8999-999999999999","role":"authenticated"}', false);
select harness.check(
  public.is_admin() = false,
  'a suspended administrator immediately loses administrator authority');
select harness.expect_error(
  format('select public.review_payment(%L, ''approved'', null)', :'sub_d'),
  'Administrator role required',
  'a suspended administrator cannot invoke privileged operations with an existing session');
reset role;

select harness.check(
  (select count(*) from harness.results where passed is false) = 0,
  'no harness assertion failed') \gset
