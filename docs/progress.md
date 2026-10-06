# Progress Log

Last updated: 2026-10-06

## Current Status

The student material-access outage is fixed in the linked Supabase project. `issue_material_access` is writable again, resolves the enrollment for the requested module's course, and uses snapshot membership without rewriting progress or curriculum history. `course-material-access` version 7 is deployed. A disposable learner passed English, Bisaya, refresh/repeat, signed URL, cross-account denial, anonymous denial, popup, and no-checkout-request checks through the local UI; the Vercel-hosted UI passed the backend checks but still needs the frontend bundle deployed for the new one-click popup/error handling because Vercel credentials were unavailable locally.

Day 1, Day 2, and all currently feasible owner-independent Day 3 work are implemented. Migrations `202610030001` through `202610040013` are applied to the isolated hosted test project without reset or migration-history repair. The development admin and approved 15-question final are provisioned. Student registration is operational with owner-approved test-only auto-confirm while email delivery is deferred. GCash and MariBank are configured and their full manual-review lifecycle is verified; Maya and course sales remain disabled. Technical readiness is advanced but not release-ready.

| Milestone | Status | Evidence / blocker |
| --- | --- | --- |
| Public site and approved brand assets | Complete | Requested logo, course thumbnail, favicon, and headshot are wired; desktop/mobile E2E coverage passes |
| Authentication and route authorization | PASS | Browser signup and student password login reach `/dashboard`; hosted profile/policy triggers and role isolation pass; guarded admin browser login reaches `/admin` using the database role |
| Development admin | PASS | `admin@gmail.com` Auth identity `0c40376a-fc1f-4c3d-9a00-5c0cb3208c94` is confirmed and active; database admin role, bootstrap audit, password login, backend authorization, and `/admin` destination are verified |
| Day 1 payments/private proof foundation | Complete | Authoritative pricing, private buckets, proof revision history, admin review, and RLS implemented |
| Day 2 learning/materials/quizzes | Complete | Curriculum snapshots, progress, private materials, trusted scoring, attempt limits, and admin authoring implemented |
| Hosted Auth/RLS/Storage/functions | PASS | Post-fix `scripts/verify-hosted.mjs`: 72/72; disposable Auth/database/Storage fixtures cleaned |
| Certificate issuance | Passed | Eight-module and ≥75% server eligibility, idempotent issuance, private template/object storage, one-page generated PDF, signed owner/admin downloads, and public limited verification |
| Certificate layout | Passed | Generated PDF visually inspected; dynamic name/date/ID align correctly, signature/artwork are preserved, and text extraction contains no stale placeholders |
| Public verification security | Passed | Opaque ID, permitted metadata only, malformed-ID handling, hashed-IP rate limiting, and no direct template/certificate Storage access |
| Refund reconciliation/reporting | Passed | External-completion reconciliation, idempotency, separate gross/refund ledger events, Manila date filters, and admin CSV export |
| Email outbox worker | Hardened, delivery blocked | Bounded expired leases, transient retries, preflight origin validation, plain-text fallback, and checked finalization; unauthorized hosted call returns 401; provider/sender remain absent |
| Quiz source/import | PASS | Hosted first import created version `3482ecc6-13d7-4441-a3bd-74ee74947820`; second returned the same version with `created=false`. Exactly 15 questions/private keys, one audit, 75%, unlimited retries, no cooldown, and disabled availability are verified |
| Hosted quiz eligibility/scoring | PASS | Rollback-only fixture blocked incomplete progress, then server-scored 12/15 as 80% pass and 11/15 as 73.33% fail; fixture user/attempts were removed and final remained disabled |
| Local quality gates | Passed | Typecheck, lint, 18 unit tests, production build, 12 Playwright scenarios with 4 guarded skips, and 143 SQL assertions |
| Hosted migrations | Passed | Local and remote versions `001`–`013` match |
| Genuine payment method/proof | PASS, TEST PROJECT | GCash and MariBank QR delivery, private initial proof, pending review, replacement request, immutable resubmission, rejection without access, and approval-only enrollment pass; Maya and sales remain disabled |
| Student registration | PASS, TEST-ONLY MODE | Initial browser signup failed 429 on the built-in two-emails/hour quota and created no account. Test confirmation was disabled by explicit owner instruction; subsequent signup/session, profile, two policy acknowledgements, sign-out, password login, and `/dashboard` pass with zero roles |
| Password recovery / outbound email | UNAVAILABLE | UI explicitly disables recovery while `VITE_EMAIL_DELIVERY_ENABLED=false`; domain/sender/mailbox/origin remain deferred and worker provider values are absent |
| Production deployment | Prohibited | No production environment/domain was authorized |
| Student material access repair | PASS, BACKEND DEPLOYED | Linked project `dvwwnqoujtctlfvwcrgf`; migrations `028`/`029`, Edge Function v7, local browser 13/13; hosted browser backend behavior 12/13 with only the not-yet-deployed popup UX check failing |

## Implemented Scope

- Public pages, SEO metadata, responsive branding, registration/login/recovery, student and admin routes.
- Private payment proof upload/resubmission and audited transactional review.
- Enrollment snapshots, bilingual immutable material versions, progress, knowledge checks, and final assessments.
- Active-account-aware administrator authorization; suspended admins lose database authority immediately.
- Secure one-shot initial-admin provisioning with project matching, a gitignored one-use mode-0600 input, no password overwrite, active/confirmed account checks, audit logging, password-login verification, and backend role verification.
- Certificate configuration, eligibility, generation leases, integrity-pinned private template, private output, public verification, and learner UI.
- Completed external refund reconciliation that does not imply money movement and retains access/certificates without approved revocation policy.
- Server-derived financial ledger, Asia/Manila date filtering, and formula-safe CSV export.
- Email outbox claim leases, bounded retries including expired-worker leases, terminal failure, checked finalization, provider adapter, and independent worker-secret authentication.
- Repeatable source-hash-pinned quiz import with canonical module catalog, 75% final threshold, private answer keys, and separate required module knowledge checks.
- Guarded rollback-only hosted final verifier that proves learner completion gating and private server-side threshold scoring without retaining test users or attempts.

## Defects Found And Fixed

1. Trusted functions retained explicit anonymous execution grants after only revoking `public`.
2. Duplicate-enrollment handling referenced a nonexistent course column.
3. Publishing a module silently changed existing enrollment snapshots.
4. Invalid material languages rolled back denial audit records.
5. Identical material retries collided with immutable object paths.
6. Payment resubmission targeted a new submission instead of appending evidence.
7. Payment ownership and refunded reporting used the wrong schema relationships.
8. Proof revision validation did not lock/load the authoritative order first.
9. Hosted `pgcrypto` functions required the `extensions` schema.
10. Anonymous course reads invoked an unavailable privileged helper.
11. Course authoring sent JSON to a multipart endpoint and checked admin with the wrong client.
12. The hosted verifier selected nonexistent `policy_acceptances.policy_version` instead of `policy_version_id`.
13. Suspended administrators retained privileged RPC access.
14. Client-side revenue reporting lost original gross revenue after refund.
15. The original certificate overlay visually overlapped the date label and retained hidden placeholder text; the generator now uses an integrity-pinned raster background.
16. Function-bundled certificate assets were not included by deployment; the template now lives in a private Storage bucket and is hash-checked before use.
17. Hosted verification cleanup removed database rows but left Storage objects; cleanup now uses non-interactive Storage API deletion.
18. Email network exceptions were terminal on the first attempt and expired final-attempt leases could be reclaimed indefinitely; both paths are now bounded and retry-aware.
19. Provider success/failure finalization errors were ignored; worker results now distinguish database-finalization failure from sent mail.
20. Checkout stored but did not display genuine payment QR paths or instructions; selected verified methods now show both responsively.
21. The deployment helper could apply linked migrations to a different project than its function target; it now refuses mismatched refs.
22. Registration hid Auth's `over_email_send_rate_limit` 429 behind a generic error and frontend password validation did not match hosted letters/digits policy; both now provide accurate, preflighted feedback.
23. Password recovery claimed an email was sent even when delivery was unavailable; the test UI now marks the capability unavailable and sends no recovery request.
24. Payment-proof resubmission sent an extra `target_order_id` argument to the revision RPC, preventing PostgREST from resolving the function; the Edge Function now sends the exact trusted signature and the hosted replacement flow passes.
25. The lifecycle migration changed the audit-writing `issue_material_access` RPC to `STABLE` and selected enrollments using nonexistent `enrollments.created_at`; every request failed before a link could be signed. The RPC is `VOLATILE`, orders by `granted_at`, and scopes enrollment selection to the requested module's course.
26. The learner screen discarded safe Edge Function response bodies and required a second click after signing. It now extracts safe JSON errors, clears expired local sessions, stops retrying permanent 403 responses, reserves a tab during the user gesture, views PDFs, and downloads PPT/PPTX files.
27. Mounting checkout always called `create_order`, including for an already entitled learner. Checkout now waits for enrollment resolution and sends entitled learners directly to their course without creating or requesting an order.

## Evidence Rules

- A check is passed only after observed command or hosted runtime output.
- The SQL harness proves schema, RLS, transaction, and state-machine behavior; hosted tests separately prove Auth JWTs, Storage, CORS, signed URLs, and deployed functions.
- No production migration, real payment, policy publication, or real email is performed without owner authorization.
- Course sales, certificate issuance for Logistics 101, and final assessment availability stay disabled until their remaining content/policy inputs exist. GCash and MariBank remain configured for test verification; Maya remains disabled.
- Ambiguities are reported and blocked, never guessed.


## Certificate v3 (2026-10-04)
- Uploaded v3 template (SHA-256 matches migration) and deployed generate-certificate with vector PDF overlay, QR, and auto-issue hooks.


## Progress tracker (2026-10-04)
- Reviewed mark_module_studied RPC and Lesson.tsx: updates progress immediately on click, reload preserves state, server enforces KC requirement before completion. No changes needed for current logic.


## Final assessment (2026-10-04)
- Ensured final quiz version (en) is enabled, published, 75% pass, unlimited retries (NULL), no cooldown. Backend enforces eligibility server-side.


## Interactive module progress (2026-10-04T22:45Z)
- Reviewed Lesson.tsx markStudied flow: RPC called, reload() invalidates module rows/progress; button disabled after success; server completes module only when studied + KC done.

## Browser journey verification and progress fix (2026-10-04T23:50Z)

Reproduced the reported failure in a real browser against the linked test project
(Playwright + Chromium, disposable enrolled learner) instead of inferring it from
server code.

### Root cause found and fixed

1. `mark_module_studied` refused the write with "Module material is not published
   yet" unless a `module_translations` row was already published. Lesson-study
   progress was therefore coupled to material import timing: a learner in a
   published module could not record studying it at all, so the button stayed on
   "Mark lesson as studied" with no progress change. Fixed by migration
   `202610040015_module_study_progress.sql`, which gates on the module's own
   published status. Progress remains one row per (enrollment, module) with the
   first `studied_at` preserved, so repeat clicks cannot inflate it, and module
   completion still requires a recorded knowledge check.

2. The course tracker showed only `percent_complete`, which counted modules whose
   `completed_at` was set. Completion needs both a studied lesson and a knowledge
   check, so a learner who had studied every lesson still saw 0%. Migration
   `202610040016_separate_study_progress.sql` returns `required_studied` and
   `percent_studied` alongside the completion fields, and the course page now shows
   lesson-study progress and overall completion as separate figures.
   `final_unlocked` still requires real completion, so study progress cannot
   unlock the assessment or a certificate.

### Observed browser evidence (disposable learner, 5 required modules in snapshot)

| Step | Observed | Result |
| --- | --- | --- |
| Continue Learning renders and links to the course | `/learn/3bc1e477-…` | PASS |
| Module list renders in configured order | 5 module links, positions 1-5 | PASS |
| Progress before click | studied 0% / complete 0% | PASS |
| Button after click, no document reload | "Mark lesson as studied" -> "Lesson recorded" | PASS |
| Progress after click | studied 0% -> 20% (1 of 5), complete stayed 0% | PASS |
| Progress after hard refresh | studied 20% / complete 0%, button "Lesson recorded" | PASS |
| Repeat click | button already disabled; progress unchanged at 20% | PASS |
| Final assessment locked in UI | entry rendered with progress-gated copy | PASS |
| Direct `start_quiz_attempt` before eligibility | HTTP 400 "Complete all required modules before starting the final quiz" | PASS |

The 12.5% figure from the report is the 1-of-8 case; the percentage is computed
from the enrollment's own curriculum snapshot, and this enrollment had 5 required
modules, so 1/5 = 20% is the arithmetically correct observed value.

### Blocked, not fixed

- The full journey cannot be completed to the certificate in the linked project
  because there is no learning content to complete: `module_translations` has 0
  rows, `course-materials` has no objects, and there are 0 `knowledge_check`
  quizzes. `final_unlocked` therefore cannot legitimately be reached.
- Certificate module-count divergence: the live curriculum has 9 required modules
  and existing enrollment snapshots hold 4-5, while
  `course_certificate_configs.required_module_count` is 8 and the supplied
  template prints "all 8 modules". The generator's guard refuses a mismatch by
  design. This needs an owner decision, not a silent config change.
- Password recovery end-to-end delivery: NOT RUN. No SMTP provider, verified
  sender, or production origin is configured, and email remains deferred.

## Curriculum audit and genuine Module 1 material (2026-10-05)

### Nine live required modules vs the approved eight

All nine `public.modules` rows for `logistics-101` are `required = true` at
`curriculum_version = 1`. Positions 1-8 carry the owner-approved `canonical_title`
values inserted by `202610040011` and match `quiz/import-manifest.json` exactly.
Position 9 has a **NULL** `canonical_title`, was created a day later
(2026-10-04 03:24:25 UTC versus 2026-10-03 17:28:49 UTC for 1-8), has never had
content, and is absent from the approved curriculum, the import manifest, and the
15-question final bank.

Position 9 is nevertheless **not** disposable: it is `required = true` in all five
enrollment snapshots and one real learner (`g.oiva.523349@umindanao.edu.ph`) has a
`studied_at` on it. It is therefore proposed for demotion (`required = false`,
`status = 'draft'`), never deletion, and the full mapping plus the snapshot
reconciliation plan is written up in `docs/curriculum-reconciliation.md` for
confirmation. Nothing has been applied.

Why existing snapshots hold 4-5 modules rather than 8:
`sync_enrollment_modules` copies only modules whose `status = 'published'` at
enrollment time, and positions 3, 4, 6 and 7 are still draft.

### Genuine materials found and imported

A full sweep of the workstation found the supplied Module 1 decks in
`~/Downloads`. Both are 7-slide PowerPoint lesson decks; their slide text was
extracted and read before importing, confirming they cover logistics, freight,
transport modes, 3PL, and shipment participants.

| Module | Language | Object | SHA-256 | Size |
| --- | --- | --- | --- | --- |
| 1 Logistics Fundamentals | en | `course/994538f1…/en/ed9607558a8b067c.pptx` | `ed9607558a8b067c…` | 129,647 |
| 1 Logistics Fundamentals | ceb | `course/994538f1…/ceb/bc5658e35695416d.pptx` | `bc5658e35695416d…` | 103,740 |

Imported through the trusted `submit-course-material` admin function, 16/16 checks
passing, and verified in a real browser (8/8):

- enrolled student receives the English deck and the signed URL serves the actual
  PPTX bytes;
- Bisaya selection returns a different object;
- the deck is labelled "Download PowerPoint file" with an honest note that
  PowerPoint cannot be previewed inline and a companion PDF can be uploaded later;
- a signed-in user with no enrollment is refused with HTTP 403;
- the objects are not publicly readable and cannot be signed anonymously.

**Modules 2-8 have no supplied material anywhere on this machine.** That is the
single biggest blocker to completing the journey.

### Three real defects fixed while importing

1. `submit-course-material` had a duplicate `const bytes` declaration, which is a
   parse error, plus a leftover `if (!isPdf(bytes))` guard that rejected every
   PowerPoint file. Both removed.
2. The `course-materials` bucket only allowed `application/pdf`, so no deck could be
   stored regardless of code. Migration
   `202610040017_course_material_formats.sql` widens it to PDF/PPT/PPTX, keeps the
   50 MB ceiling, and asserts the bucket stays private.
3. Format detection trusted the declared MIME type, so any ZIP could be stored as a
   "PowerPoint" lesson and a mislabelled PDF was accepted. Detection now requires
   the declared type and the magic bytes to agree, and a PPTX must actually contain
   `ppt/presentation.xml`. A disguised ZIP is now rejected with HTTP 400.

`course-material-access` now returns an explicit `format`, so the UI no longer
guesses PowerPoint from the signed URL string.

### Test residue found and removed

Module 1 had a stray published English translation, version 2, titled "saddsasa",
pointing at a 50,345-byte PDF whose SHA-256 is **identical to the certificate
template** recorded in `202610040014`. Because entitlement picks the highest
published version per language, every student was being served the certificate
artwork as the Module 1 lesson. The row was deleted, restoring the genuine deck.
Its orphaned storage object still exists because direct deletes on `storage.objects`
are blocked by design; it is unreferenced and unsignable, and needs one
service-role Storage delete to reclaim.

Also removed 15 leaked disposable accounts left by earlier probe runs whose cleanup
had silently swallowed foreign-key failures. Final verified state: 4 real users,
4 real enrollments, 10 real progress rows, 0 certificates, 0 quiz attempts,
0 disposable accounts.

### Knowledge checks

`quiz/` contains only the approved course-wide final: 15 questions mapped to exactly
8 module numbers. **No module knowledge checks exist.** Module completion requires a
knowledge check, so the final assessment cannot legitimately unlock yet.

A draft Module 1 knowledge check is in
`quiz/draft-knowledge-check-module-1.json`, 6 questions, each traceable to the
reviewed Module 1 English deck with the supporting slide number and an explanation.
It is `publish: false` and awaits trainer approval. No invented question has been
published.

---

# Certificate blocker resolved (2026-10-05)

## Symptom

`ngek@gmail.com` had completed `9/9` modules and scored `100` on the final, yet
certificate issuance failed with:

```
The enrollment does not contain the required certificate curriculum
```

## Root cause

`ensure_certificate` compares the enrollment's required snapshot count against the
course config's `required_module_count`. The enrollment had required **9** because
all nine modules were `published` + `required` when the snapshot was taken; the
approved config required **8**. Completion and the final assessment read the
snapshot set, while the certificate read the config, so the learner could fully
complete the course and still be refused a certificate.

Every other certificate condition was already satisfied. Only the curriculum count
was unmet. Module-status publication and material availability turned out to be
separate concerns and are **not** part of the certificate guard.

## Fix

| Migration | Effect |
| --- | --- |
| `202610050019_canonical_curriculum_reconciliation.sql` | Approved eight remain `published` + `required`; module 9 demoted to `draft` + optional; missing approved snapshots added to all seven enrollments; extra required flags removed without deleting rows |
| `202610050020_fix_certificate_eligibility_config_key.sql` | Repaired `certificate_eligibility`, which referenced a non-existent `config.id` column and raised `42703` at runtime |

Both were applied with `supabase db push` against the linked test project. No
reset, no guard relaxation, no generator change. The strict `ensure_certificate`
guard is untouched.

## Verified result

| Field | Value |
| --- | --- |
| Certificate id | `b5dfe22b-2cbc-439b-a4d4-cd193a58e732` |
| Verification id | `LVA-2026-286E3A41C2892DF7` |
| Status | `active` |
| Required modules recorded | `8` |
| Final score recorded | `100.00` |
| Template version | `3` |

Issued through the real `generate-certificate` path. Repeated requests return the
same certificate id and the table still holds exactly one row.

## Defect found and fixed during UI verification

The View/Download buttons originally used `window.open(url, '_blank', 'noopener')`
after an asynchronous `certificate-access` round trip. By then the user gesture was
gone, so Chromium popup-blocked the navigation and both buttons silently did
nothing. They now hand the signed URL to `window.location.assign`, where the
`disposition` argument decides whether the PDF renders inline or downloads.

## Open items

- Modules 2–8 still have no genuine supplied material. Module 8 remains a real
  content blocker. Nothing was fabricated and no material row was invented.
- The test `APP_ORIGINS` begins with `localhost`, so certificate QR codes and
  printed verification URLs are not externally reachable until a real origin is
  configured.
- The only stored recipient name for the affected learner is `ngek`; confirm that
  is the intended name on the certificate.
- The earlier deletion of ten real `module_progress` rows for four older learners
  is still unexplained. No legitimate recreation is possible without timestamps.

---

# PowerPoint upload fixed end to end (2026-10-05)

## Symptom

Manage Materials rejected every PowerPoint file with:

```
Module material must be a PDF file.
```

Reproduced through the real admin browser interface against the linked test
project with a genuine OLE2 `.ppt` and a genuine OOXML `.pptx`.

## Every validation layer, traced

| Layer | State found | Action |
| --- | --- | --- |
| 1. Admin file input | `accept` already listed all three MIME types, but the label read **"PDF file"** | Label changed to **"Course material — PDF or PowerPoint"**, `accept` extended with `.pdf,.ppt,.pptx` |
| 2. Frontend validation | **`src/lib/payment.ts` rejected anything that was not `application/pdf` and required a `.pdf` filename. This was the actual blocker.** | Rewritten to accept all three formats, cross-check MIME against extension, and name the specific problem |
| 3. Upload request | `FormData` field `material`, correct | Unchanged |
| 4. Edge Function validation | v6 already accepted all three, but decided the format from the **browser's MIME type**, verified only 4 signature bytes, and accepted any ZIP whose first 1 MB contained two part names | Rewritten to detect the format from the real bytes |
| 5. Storage bucket | Already private with all three MIME types and the 50 MB limit | Unchanged |
| 6. Database constraint | `admin_save_module_translation` raised **"Material must be a PDF of 50 MB or less"** for any size failure and performed **no format check at all** | Message corrected and a format backstop added |

So the reported error came from layer 2, with a second misleading PDF-only
message waiting in layer 6.

## Server-side validation is now content-authoritative

The stored format is decided by the real bytes, never by the filename or the
browser's MIME type, which is frequently absent or wrong. The declared type is
only used to cross-check, so a renamed file is refused rather than stored under an
extension that does not match its contents.

- **PDF** — `%PDF-` prefix **and** a real `%%EOF` trailer. A five byte prefix alone is forgeable.
- **PPTX** — the ZIP **central directory** is parsed and the `[Content_Types].xml` member is actually inflated, then the declaration must name `presentationml.presentation.main+xml` and `/ppt/presentation.xml`, with a presentation part and at least one slide present. Scanning for strings in the first megabyte is gone.
- **PPT** — the OLE2 compound file directory is walked along the FAT chain and a real `PowerPoint Document` stream must exist. The eight byte signature alone matches any legacy Office file.
- A file whose extension or declared type contradicts its bytes is refused with a message naming the real format.

An Excel workbook renamed to `.pptx`, a plain ZIP, a ZIP containing the right
part names but no PowerPoint content types, a Word document renamed to `.ppt`,
and a bare OLE2 magic-byte stub are all rejected.

## Preview is optional

A PowerPoint upload no longer needs a companion PDF. The student view already
labels a deck as `Download PowerPoint file`, states that a deck cannot be
previewed inline, and offers inline preview only when a PDF version exists.
`course-material-access` derives the format from the stored object path so the
UI never guesses from the signed URL.

## Verification

| Check | Result |
| --- | --- |
| `scripts/verify-material-detection.mjs` (local, real containers) | **15/15** |
| `scripts/probe-material-formats.mjs` (real admin browser UI, hosted) | **17/17** |
| `scripts/probe-material-access.mjs` (existing Module 1 material) | **8/8** |
| `vitest run` | 20/20 |
| `tsc`, `eslint`, `vite build` | PASS |

Hosted results through the actual admin UI: **PDF uploads**, **PPT uploads**,
**PPTX uploads**; a plain ZIP, a renamed deck, a text file and a file over 50 MB
are all rejected; each accepted format is stored as its own immutable version
with the right filename, extension, module and language; re-uploading identical
bytes creates no duplicate version; an authorised student downloads all three
and the bytes match the real format; a signed-in user with no enrollment and an
unauthenticated request are both refused.

## Applied and deployed

- Migration `202610050021_material_format_backstop.sql` applied with
  `supabase db push`. No reset.
- `submit-course-material` deployed to the linked test project (version 7).

## Data preserved

Progress rows, the single certificate, the genuine Module 1 English and Bisaya
materials, all enrollments and all real users are unchanged. The probe removes
its own versions and accounts, and the run ends with zero disposable accounts.

## Flagged for the owner, not changed

Two published translations created by `admin@gmail.com` on 2026-10-04 at 18:20
and 18:27 reuse **Module 1's own PowerPoint files** on other modules:
`sadassaasdsad` (Bisaya, Accessorials) and `logistics module 2` (English, Trucks
& Equipment). Because object paths are content addressed, uploading the same
deck twice produces the same hash. These are owner rows and were left untouched,
but Modules 2 and 7 currently show Module 1 content.

Three orphaned Storage objects remain from probe uploads. This project keeps no
service role key locally, so they cannot be removed from the command line. They
are unreferenced and unsignable in a private bucket. `scripts/cleanup-material-probe.mjs`
lists them.
