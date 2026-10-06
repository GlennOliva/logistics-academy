# Test Report

Date: 2026-10-06
Environment: local macOS workspace, PostgreSQL 17 throwaway harness, and positively matched isolated Supabase test project

## Results

| Check | Result | Evidence / reason |
| --- | --- | --- |
| TypeScript strict typecheck | PASS | `npm run typecheck` |
| ESLint | PASS | `npm run lint` |
| Unit tests | PASS | `npm test`: 18/18 |
| Production build | PASS | Vite build succeeds; existing >500 kB bundle warning remains non-blocking |
| Desktop/mobile E2E | PASS | 12 passed; 4 guarded hosted-mutation/admin-login checks skipped without explicit flags |
| Ordered migrations on PostgreSQL 17 | PASS | Clean apply of migrations `001`–`013` |
| SQL/RLS/transaction harness | PASS | 143/143, including GCash/MariBank-only configuration |
| Quiz source validation | PASS | 15 questions; CSV/JSON equivalent; approved manifest/hash and eight normalized titles match |
| Quiz trusted import | PASS | Hosted first import created version `3482ecc6-13d7-4441-a3bd-74ee74947820`; second returned `created=false`; exactly one version/audit, 15 questions, 15 private keys, 75%, and disabled availability |
| Hosted quiz private access | PASS | `authenticated` has neither private-schema usage nor answer-key table SELECT privilege |
| Hosted quiz eligibility | PASS | Rollback-only learner cannot start before all eight required module snapshots are complete; completed snapshots include knowledge-check timestamps |
| Hosted quiz server scoring | PASS | Private server keys score 12/15 as 80% pass and 11/15 as 73.33% fail; client does not submit scores/pass flags |
| Hosted quiz cleanup | PASS | Transaction rolled back; test-prefix Auth users and imported-quiz attempts remain zero; persistent final remains disabled |
| Hosted migration history | PASS | Local and remote `001`–`013` match; no reset or repair |
| Registration failure reproduction | PASS | Real browser `POST /auth/v1/signup` returned 429 `over_email_send_rate_limit`; application showed the previous generic error; Auth/profile checks proved no account was created |
| Registration feedback fix | PASS | Repeated 429 browser response displays that verification sending is rate-limited and the attempt created no account; no password/token logged |
| Registration environment/redirect | PASS | Browser reached the linked project using `VITE_SUPABASE_URL`/`VITE_SUPABASE_PUBLISHABLE_KEY`; request redirect was `http://localhost:5173/auth/callback`, present in hosted allowlist |
| Test-only Auth confirmation mode | PASS | Guarded config changed only `auth.email.enable_confirmations` to false by owner instruction; remote password, redirects, MFA, database, and storage settings were preserved |
| Hosted student signup/login route | PASS | Browser signup 200 with confirmed test session → `/dashboard`; sign-out then password login 200 → `/dashboard`; no Admin navigation |
| Hosted admin browser login route | PASS | Guarded hidden-password Playwright check reported login HTTP 200 and asserted `/admin`; follow-up SQL confirms the same active admin role and zero disposable users |
| Hosted signup trigger | PASS | Student profile is active with exact name/language, two policy acknowledgements, and zero roles |
| Hosted signup/login/profile/policy trigger | PASS | Disposable admin and two students signed up and logged in; profile and two acknowledgements created |
| Hosted role isolation | PASS | Trusted admin role succeeds; student admin operations and cross-profile reads fail |
| Hosted private materials | PASS | Admin upload/publish, unpaid denial, owner signed URL, direct Storage denial, admin preview, and event isolation |
| Hosted protected functions | PASS | Missing JWT returns 401 for payment, material, certificate, and report functions |
| Hosted certificate generation | PASS | Private template retrieved and hash-checked; PDF generated, private output persisted, owner/admin signed downloads succeed |
| Certificate PDF layout | PASS | One A4-landscape page; dynamic text aligned; stale placeholder text absent from extraction; signature artwork preserved |
| Certificate public verification | PASS | Only status, verification ID, student/course snapshots, and dates returned; malformed IDs return 404; rate limit returns 429 |
| Private template access | PASS | Authenticated student direct Storage download denied |
| Hosted refund reconciliation | PASS | Completed external refund recorded without moving money or revoking access |
| Hosted financial ledger | PASS | Separate ₱699 gross and ₱699 refund events produce ₱0 net |
| Hosted CSV export | PASS | Admin receives CSV, formula-prefix cells are neutralized, and student receives 403 |
| Email worker unauthenticated call | PASS | Redeployed worker independently returns 401 without worker secret after hardening |
| Email worker authenticated fail-closed | PASS | Authorized worker-secret call returns 503 while provider/sender are unconfigured; no outbox row is claimed or marked sent |
| Hosted fixture cleanup | PASS | Disposable Auth/course rows absent; generated certificate and orphan material objects removed through Storage API |
| Hosted email confirmation setting | TEST-ONLY DISABLED | Owner deferred SMTP and explicitly approved development/test signup without mandatory confirmation; production was not changed or deployed |
| Hosted password minimum | PASS | Updated to 8 characters with letters/digits requirement; undeclared remote settings preserved |
| Development admin | PASS | Exact reported user ID is confirmed/active with database admin role and bootstrap audit; provisioning command verified password login, backend role, and `/admin` destination |
| Real confirmation email | NOT RUN | Explicitly deferred; custom SMTP/domain/sender/test mailbox are unavailable |
| Password recovery email | UNAVAILABLE | UI capability flag is false and recovery request is disabled until delivery is configured |
| Payment method configuration | PASS | Student RLS exposes exactly GCash and MariBank; Maya is disabled; both public branding QR objects return JPEG; course sales remain false |
| Positive payment-proof review | PASS | Hosted private GCash submission enters pending; admin requests replacement; MariBank resubmission preserves two immutable revisions; rejection grants no access; a separate pending MariBank submission grants active enrollment only after approval |
| Real outbound email | NOT RUN | Provider, verified sender, and approved production origin are unavailable |
| Hosted quiz import path preflight | PASS | Initial invocation typo failed before npm/database access; persisted files contained no typo and pre-retry SQL found no test user/attempt residue |
| Post-change full hosted verifier | PASS | 72/72 after resubmission RPC fix; cleanup left zero disposable users/submissions/revisions, owner admin intact, imported final disabled, sales off, and exactly two approved methods enabled |
| Material-access failure reproduction | PASS | Hosted RPC returned SQLSTATE 42703: `enrollments.created_at` does not exist. The deployed v6 function converted that to HTTP 403 `{ "error": "Unable to open this material" }`; no denial audit row could commit. Inspection also found the write-producing RPC incorrectly declared `STABLE`. |
| Affected material records | PASS | Module `994538f1-1544-4df0-aaba-f968f7addf93` belongs to course `3bc1e477-8736-42f2-8a1d-e5eeda290f39`, is published/unarchived at curriculum v1, has live English/Bisaya versions, and every selected private Storage object exists. All 22 active snapshots are required and match v1. No record repair was required. |
| Material-access migrations | PASS | Only pending migrations `202610060028` and `202610060029` were pushed without reset; local/remote histories match. The final RPC is `VOLATILE`, course-scoped, snapshot-authorized, and service-role-only. |
| Material-access Edge Function | PASS | `course-material-access` version 7 deployed to positively matched project `dvwwnqoujtctlfvwcrgf`; JWT verification remains enabled and Storage remains private. |
| Local authenticated material browser probe | PASS | 13/13: English and Bisaya return distinct signed PDF links and real PDF bytes; refresh/repeat works; three clicks reserve three tabs; anonymous is 401; another signed-in account is 403 with the safe reason; lesson sends zero `create_order` calls; fixtures removed. |
| Hosted Vercel material browser probe | PARTIAL PASS | 12/13 against `https://logistics-academy-orpin.vercel.app`: both languages, signed bytes, refresh/repeat, anonymous/cross-account denial, and zero `create_order` requests pass. Popup reservation is absent because the current frontend bundle predates this fix. Frontend deployment NOT RUN: no Vercel credentials are available on this machine. |
| `create_order` investigation | PASS | Only `Checkout` mounts the RPC. Actual entitled-learner response is HTTP 400 `This account already has access to Logistics 101; contact support instead of paying again`; before/after order counts are equal. The learning route issued zero requests. Checkout now redirects entitled learners before invocation. |
| Material-access focused unit tests | PASS | Safe Edge Function error extraction covers JSON 403 details and non-JSON 500 fallback; full Vitest result 34/34. |
| Material-access local quality gates | PASS | Typecheck, ESLint, production build, and `git diff --check` pass. Existing >500 kB Vite chunk warning remains non-blocking. |
| Linked database lint after repair | MATERIAL FUNCTION PASS | `issue_material_access` has no remaining lint finding. Existing unrelated findings remain in certificate eligibility and admin lifecycle helpers. |
| Supabase Edge Function log retrieval | NOT RUN | CLI 2.119 exposes function versions/deployment but no log command, and Dashboard/API log credentials were unavailable. Version 7 now emits sanitized denial/signing/check messages without tokens, signed URLs, user IDs, or object paths. |

## Hosted Runtime Scope

The guarded hosted verifier proves real Supabase behavior rather than inferring it from deployment:

- Auth signup, password login, profiles, policy acknowledgements, and trusted role assignment.
- RLS isolation across students and suspended/admin boundaries.
- Private Storage upload and signed-download paths for materials and certificates.
- CORS and missing-JWT behavior.
- Certificate eligibility fixture with exactly eight completed required modules and a trusted 75% final result.
- Private certificate template denial, generated PDF access denial, owner/admin signed links, public verification fields, malformed IDs, and throttling.
- Completed-refund reconciliation, financial ledger arithmetic, and admin-only CSV export.
- Approved final source-hash idempotency, private answer-key privileges, eight-module eligibility, and server-computed pass/fail behavior.
- Course sales remain unavailable throughout; GCash and MariBank stay configured while isolated fixture orders exercise the payment workflow without opening checkout.

All disposable database rows are removed in `finally`. Storage objects are deleted through the Storage API because direct SQL deletion is intentionally prohibited.

## Local Harness Scope

The harness switches among anonymous, authenticated student, suspended student, administrator, service role, and superuser contexts. It verifies payment transactions, immutable evidence, enrollment snapshots, material authorization, scoring, exact-75 final passing, certificate idempotency/privacy, refund idempotency, ledger dates/totals, outbox leases/retries, and suspended-admin revocation.

Private quiz answer keys are omitted from generated frontend types and cannot be selected by browser roles. Local and hosted checks prove exactly one private key per question, source-hash idempotency, completion gating, and server-derived scoring.


- Certificate v3 uses vector PDF template (SHA-256 83d5...), with QR drawn in vector and printed URL at exact layout; sample PDF verified via text extraction and coverage checks.

## Residual Risks

- Certificate static artwork is rasterized at 2400×1697 to remove semantic placeholders; visual output passed inspection, but future template revisions need the same conversion/hash/update process.
- Standard PDF fonts support common Western names but not every Unicode script; a licensed Unicode font is still needed before accepting names outside that character set.
- No real email-provider response has been tested.
- The standalone `deno check` command was unavailable locally; the deployed worker bundle succeeded, but positive provider behavior remains unverified.
- Browser bundle code splitting remains an optimization opportunity, not a correctness blocker.

- Final assessment enabled (published, 75%, unlimited retries, no cooldown) for logistics-101; eligibility and scoring remain server-side.

## Browser-Verified Learner Journey (2026-10-04)

Run with Playwright/Chromium against the linked test project `dvwwnqoujtctlfvwcrgf`
using a disposable admin-granted enrollment. All disposable fixtures were deleted
afterwards; post-run counts confirmed 7 users, 5 enrollments, 0 certificates, 0
quiz attempts remaining, and zero `academy-journey%` residue.

| Check | Observed result |
| --- | --- |
| Continue Learning link from dashboard | PASS — links to the enrolled course |
| Ordered module list with indicators | PASS — 5 modules in configured order |
| Progress before marking studied | PASS — studied 0% / complete 0% |
| Button becomes "Lesson recorded" without reload | PASS — RPC returned 200, label changed in place |
| Lesson-study percentage increases | PASS — studied 0% -> 20% (1 of 5), completion held at 0% |
| Progress persists after hard refresh | PASS — studied 20% / complete 0% |
| Repeated clicks do not inflate progress | PASS — button disabled after success; value unchanged |
| Lesson study distinguished from completion | PASS — knowledge-check gate keeps completion at 0% |
| Final assessment locked before requirements (UI) | PASS |
| Final assessment refused by direct API | PASS — HTTP 400 "Complete all required modules before starting the final quiz" |
| Account approval gating preserved | PASS — `grant_manual_enrollment` refused a non-admin caller |

### Defects found by this run and fixed

- `mark_module_studied` returned "Module material is not published yet" for a
  published module with no translation row, so the click silently did nothing.
  Reproduced via browser network log; fixed in `202610040015`.
- The single completion-based percentage made studying every lesson still read
  0%. Fixed in `202610040016` by reporting lesson-study progress separately while
  keeping `final_unlocked` completion-gated.

### NOT RUN

- Final assessment unlocked, quiz submission, passing result, and automatic
  certificate issuance in the browser: NOT RUN. No module materials
  (`module_translations` = 0 rows, `course-materials` = 0 objects) and no
  `knowledge_check` quizzes exist in the linked project, so the completion
  requirement cannot legitimately be met.
- Password recovery delivery end to end: NOT RUN. No SMTP provider, verified
  sender, or production origin is configured; the UI already reports recovery as
  unavailable instead of claiming an email was sent.
- PPT/PPTX authorized-access and rejection checks: NOT RUN in this pass. The upload
  path accepts the three formats, but no slide decks exist to exercise it.

### Local checks

| Check | Result |
| --- | --- |
| `tsc --noEmit` | PASS |
| `eslint . --max-warnings 0` | PASS |
| `vitest run` | PASS — 18/18 |
| `vite build` | PASS |
| `playwright test tests/e2e/public.spec.ts` | PASS — 8/8 across desktop and mobile |
| Remote migration history | PASS — 202610030001 through 202610040016 aligned |

## Curriculum and Material Pass (2026-10-05)

### Module inventory (evidence-based)

| # | Canonical title | Status | In snapshots | Progress rows | Material |
| --- | --- | --- | --- | --- | --- |
| 1 | Logistics Fundamentals | published | 5/5 | 1 | EN + Bisaya PPTX (imported) |
| 2 | Trucks & Equipment | published | 5/5 | 1 | missing |
| 3 | Carrier Sourcing | draft | 0 | 0 | missing |
| 4 | Booking and Rate Negotiation | draft | 0 | 0 | missing |
| 5 | Documents | published | 5/5 | 1 | missing |
| 6 | Dispatch and Track and Trace | draft | 0 | 0 | missing |
| 7 | Accessorials | draft | 0 | 0 | missing |
| 8 | Delivery and Load Closing | published | 5/5 | 1 | missing |
| 9 | **NULL (not approved)** | published | 5/5 | 1 | missing |

Position 9 is the extra module: NULL `canonical_title`, created after the approved
eight, absent from migration `202610040011`, absent from `quiz/import-manifest.json`,
and absent from the 15-question bank. It is retained, not deleted, because real
students depend on it. Proposed mapping and reconciliation:
`docs/curriculum-reconciliation.md` (awaiting confirmation, nothing applied).

### Material import and browser access

| Check | Result |
| --- | --- |
| Genuine supplied decks located and slide text reviewed | PASS — 2 decks, 7 slides each |
| Import via trusted admin function | PASS — HTTP 201 for both languages |
| Re-import is idempotent | PASS — same content-addressed objects, no duplicate rows |
| Non-admin cannot author material | PASS — HTTP 403 |
| Non-PowerPoint ZIP rejected | PASS — HTTP 400 |
| Objects not publicly readable | PASS — HTTP 400 anonymous |
| Objects cannot be signed anonymously | PASS — HTTP 400 anonymous |
| Bucket remains private | PASS |
| Path embeds source digest | PASS |
| Enrolled student opens English material in browser | PASS — real 129,647 PPTX bytes |
| Enrolled student opens Bisaya material | PASS — distinct object |
| PowerPoint labelled as download with honest preview note | PASS |
| Signed-in user without enrollment refused | PASS — HTTP 403 |
| No unexpected browser console errors | PASS |

Import harness: 16/16. Browser harness: 8/8.

### Defects found and fixed

- `submit-course-material` contained a duplicate `const bytes` declaration (a parse
  error) plus a leftover PDF-only guard that rejected every deck.
- `course-materials` bucket accepted `application/pdf` only; migration
  `202610040017` widened it to PDF/PPT/PPTX while keeping the bucket private and the
  50 MB ceiling.
- Format detection trusted the declared MIME type, so any ZIP could be stored as a
  PowerPoint lesson. Detection now requires declared type and magic bytes to agree
  and requires real PowerPoint parts.
- A stray published Module 1 English row (version 2, title "saddsasa") held the
  **certificate template bytes** and shadowed the genuine lesson for every student.
  Removed; entitlement now serves the real deck.
- Probe cleanup silently swallowed foreign-key failures and had leaked 15 disposable
  accounts. Cleanup now covers every table referencing `auth.users`, reports each
  failure, and verifies zero residue.

### NOT RUN

- Requirements complete → final unlocks → submit → pass → certificate issued and
  downloaded: **NOT RUN.** Seven of eight modules have no supplied material and no
  knowledge check exists, so completion cannot legitimately be reached. The final
  assessment correctly refuses with HTTP 400 "Complete all required modules before
  starting the final quiz."
- Module knowledge checks in the database: **NOT RUN / not created.** A 6-question
  draft for Module 1 exists at `quiz/draft-knowledge-check-module-1.json`, derived
  only from the reviewed deck, and is `publish: false` pending trainer approval.
- Curriculum reconciliation (insert approved modules 3/4/6/7 into snapshots, demote
  module 9 to `required = false`): **NOT APPLIED**, pending confirmation of the
  mapping. Certificate eligibility and the generator guard are untouched.
- Password recovery delivery: **NOT RUN.** No SMTP provider, verified sender, or
  production origin is configured.
- Orphaned storage object
  `course/994538f1…/en/83d538deda959a93.pdf`: still present but unreferenced and
  unsignable. Needs one service-role Storage delete; direct SQL deletes are blocked
  by `storage.protect_delete`.

### Local checks

| Check | Result |
| --- | --- |
| `tsc --noEmit` | PASS |
| `eslint . --max-warnings 0` | PASS |
| `vitest run` | PASS — 18/18 |
| `vite build` | PASS |
| `node --check` on probe scripts | PASS |
| `playwright test tests/e2e/public.spec.ts` | PASS — 8/8 |
| Browser journey probe | PASS — 9/9 |
| Remote migrations | PASS — through `202610040017`, no reset |

---

# Certificate issuance verification (2026-10-05)

Two probes were written and both pass. Neither touches the real learner except to
read the already-issued certificate; the browser probe uses a disposable eligible
learner that is deleted afterwards.

| Probe | Result |
| --- | --- |
| `node scripts/probe-certificate.mjs` | **PASS — 28/28** |
| `node scripts/probe-certificate-browser.mjs` | **PASS — 18/18** |

## `probe-certificate.mjs` — real enrollment, API and PDF

Covers server eligibility and every blocker reported separately, the passing final
attempt, issuance through `generate-certificate` by a disposable admin, the stored
row (`8` required modules, final score `100`, template `v3`), idempotent repeat
requests, private view and download links, PDF magic bytes, single page, QR
presence, rendered student name, course title, verification id, and the public
verification endpoint returning `200` for a known id and `404` for an unknown one.

The course-title assertion matches case-insensitively because the template renders
the title in uppercase.

## `probe-certificate-browser.mjs` — real Chromium

Drives the whole learner journey in a browser:

- New enrollment receives exactly the eight approved required modules.
- All eight are completed through the real `mark_module_studied` RPC.
- The final is started and scored through the real `start_quiz_attempt` and
  `submit_quiz_attempt` RPCs and passes at `100`.
- The learner page shows the approved required-module count and issues the
  certificate automatically on load.
- **Download** requests the signed storage object, receives
  `content-disposition: attachment` with the filename
  `Logistics-101-Certificate-<verification-id>.pdf`, and Chromium saves a real
  49,103-byte file whose first bytes are `%PDF-`.
- **View** requests the same object with no attachment disposition, so it renders
  inline.
- The public verification page renders the certificate anonymously.
- Reloading does not duplicate issuance: exactly one certificate row, exactly one
  issuance request.

The answer key used to drive the disposable final attempt is read from the private
`quiz_answer_keys` schema. The attempt itself is started, scored and passed by the
trusted RPCs; no attempt, score or certificate row is written directly.

## Regression caught by the browser probe

`window.open` after an async call was popup-blocked, so View and Download did
nothing for a real user. Fixed in `src/learn/hooks.ts` by navigating with
`window.location.assign`. Both actions are now covered by assertions on the actual
storage response headers and on the file Chromium wrote to disk.

## Local checks

| Check | Result |
| --- | --- |
| `tsc --noEmit` | PASS |
| `eslint .` | PASS |
| `vite build` | PASS |
| `node --check` on both probe scripts | PASS |

## Known limits

- `APP_ORIGINS` starts with `localhost`, so the QR code printed on the certificate
  is only reachable while a local server is running. Configure a real origin before
  release.
- Recipient name for the affected learner is stored as `ngek`; confirm it is the
  intended certificate name.
- Modules 2–8 have no genuine supplied material yet.

---

# Course material format verification (2026-10-05)

## `scripts/verify-material-detection.mjs` — 15/15

Extracts the detector from the deployed function source and runs it against real
containers built by the test itself, plus the real supplied certificate deck.

Accepted: a real PDF, a PDF with no browser MIME type, a genuine OLE2 `.ppt`, a
`.ppt` sent as `application/octet-stream`, a genuine OOXML `.pptx`, a `.pptx`
with no browser MIME type, and the real supplied certificate deck.

Rejected: a plain ZIP named `.pptx`, an Excel workbook named `.pptx`, a ZIP that
carries the PowerPoint part names but no PowerPoint content types, a bare eight
byte OLE2 stub, a Word document named `.ppt`, a PDF with no `%%EOF` trailer, a
text file, and a `.pptx` sent with a `.ppt` MIME type.

## `scripts/probe-material-formats.mjs` — 17/17

Drives the real admin browser UI against the linked test project. Every upload
goes through the file picker, the client validator, the deployed edge function,
private Storage and `admin_save_module_translation`. No row or object is written
directly.

| Assertion | Result |
| --- | --- |
| Admin signs in | PASS |
| PDF uploads | PASS — `logistics-basics.pdf` |
| PPT uploads | PASS — `logistics-basics.ppt` |
| PPTX uploads | PASS — `logistics-basics.pptx` |
| Plain ZIP named `.pptx` rejected | PASS |
| PPTX renamed to `.ppt` rejected | PASS |
| Text file rejected | PASS |
| File over 50 MB rejected | PASS |
| One version saved per format | PASS |
| Version carries the requested language | PASS |
| Stored path records the real format | PASS — `.pdf`, `.ppt`, `.pptx` |
| Re-upload creates no duplicate version | PASS |
| Enrolled student downloads PDF | PASS — `format=pdf`, `%PDF-` |
| Enrolled student downloads PPT | PASS — `format=ppt`, OLE2 signature |
| Enrolled student downloads PPTX | PASS — `format=pptx`, `PK\x03\x04` |
| User with no enrollment refused | PASS |
| Unauthenticated request refused | PASS — HTTP 401 |

Format rejections reported by the server are specific, for example:
`This ZIP archive is not a PowerPoint presentation. A .pptx file must contain
[Content_Types].xml, ppt/presentation.xml and at least one slide.`

## Regression

| Check | Result |
| --- | --- |
| `scripts/probe-material-access.mjs` | PASS — 8/8 |
| `vitest run` | PASS — 20/20 |
| `tsc --noEmit` | PASS |
| `eslint .` | PASS |
| `vite build` | PASS |

The existing Module 1 material still downloads correctly in both languages, the
PowerPoint is still labelled as a download rather than inline preview, and the
probe ends with zero disposable accounts and zero probe versions.
