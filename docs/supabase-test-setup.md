# Supabase Test Project Setup

This procedure is for the isolated hosted test project only. It is not a production deployment guide.

## Safety Rules

- Positively match the linked project ref to `VITE_SUPABASE_URL` before mutation.
- Inspect remote migration history and apply only genuinely pending migrations.
- Never use `db reset`, repair history to hide a mismatch, enable course sales, or transfer real funds for verification.
- Keep service-role/provider/worker secrets out of `.env.local`, `VITE_*`, source, command output, and documentation.
- Restore email confirmation immediately after any temporary auto-confirm test window.
- Remove disposable Auth, database, and Storage fixtures after each run.

## Browser Configuration

`.env.local` contains browser-safe values only:

```text
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=<publishable-key>
VITE_APP_ORIGIN=http://localhost:5173
```

The service-role key is platform-managed for Edge Functions. Application secrets are set through an approved secret mechanism with `supabase secrets set`.

## Link And Verify

```bash
npx supabase login
npx supabase link --project-ref <project-ref>
npx supabase projects list
npx supabase migration list --linked
```

The current ordered migration history is `202610030001` through `202610040013`. Apply only absent versions:

```bash
npx supabase db push --linked --dry-run
npx supabase db push --linked
```

Never reset the hosted database. The current seed keeps Logistics 101 sales disabled; migration `013` configures only the approved GCash and MariBank destinations and leaves Maya disabled.

## Auth Configuration

- Site URL: the exact test application origin.
- Redirect allowlist: `/auth/callback` and `/reset-password` for each test origin.
- Email confirmation: currently disabled only in this isolated test project by explicit owner instruction while SMTP is deferred.
- Minimum password length: 8.
- Password requirement: letters and digits.

Production and any public environment must enable confirmation and configure verified email delivery. The guarded `auth:test:no-confirm` command changes only the linked test project's confirmation flag and refuses a project-ref mismatch. Do not run it against production.

## Private Certificate Template

The supplied certificate source remains outside `public/`. The runtime background is stored only at:

```text
certificate-templates/logistics-101/v2/background.png
```

The bucket is private and has no anonymous/authenticated object policy. Before upload:

1. List the exact remote path and do not overwrite an unexpected object.
2. Verify the local SHA-256 against `course_certificate_configs.template_sha256`.
3. Upload with `image/png` and `Cache-Control: no-store`.
4. Download through the CLI and verify the remote bytes have the same SHA-256.

The generator retrieves the path with its service client and refuses a hash mismatch.

## Edge Functions

JWT-protected functions:

- `submit-payment-proof`
- `submit-payment-proof-resubmission`
- `course-material-access`
- `submit-course-material`
- `generate-certificate`
- `certificate-access`
- `admin-report-csv`

Public/custom-auth functions:

- `verify-certificate`: `verify_jwt=false`; validates opaque IDs, returns limited public fields, and rate-limits a salted hash of caller IP.
- `email-outbox-worker`: `verify_jwt=false`; independently requires `EMAIL_WORKER_SECRET` and fails closed if provider/sender configuration is absent.

Deploy according to `supabase/config.toml`. Deployment output alone is not runtime evidence.

## Guarded Hosted Verification

The verifier refuses mutation unless explicitly enabled and confirms the linked/project URL match:

```bash
set -a
source .env.local
HOSTED_TEST_ALLOW_MUTATION=1 node scripts/verify-hosted.mjs
```

It exercises:

- Disposable signup, password login, profile/policy triggers, and trusted admin role.
- Cross-student RLS and student/admin operation boundaries.
- Private material authoring, signed access, direct Storage denial, and access-event isolation.
- Missing-JWT and CORS behavior.
- Eight-module certificate eligibility, private template retrieval/integrity, generated PDF, signed download, public metadata, malformed IDs, and rate limiting.
- Completed external refund reconciliation, gross/refund/net ledger arithmetic, admin CSV, and student CSV denial.
- Independent email-worker rejection without its worker secret.
- Sales/payment-method closed state throughout.

The approved final has a separate rollback-only hosted verifier:

```bash
EXPECTED_SUPABASE_PROJECT_REF='dvwwnqoujtctlfvwcrgf' \
HOSTED_QUIZ_TEST_ALLOW_MUTATION=1 \
npm run quiz:verify:hosted
```

It temporarily creates a learner and enables the final inside one transaction, proves incomplete-progress denial and server-derived pass/fail scores, then rolls back. A successful run must report that the learner fixture was removed and the final is still disabled.

The verifier removes disposable rows in `finally` and removes generated Storage objects with the Storage API. Direct SQL deletion from Storage is intentionally blocked by Supabase. Its signup/session phase currently uses the owner-approved test-only no-confirm setting; this is not production email evidence.

## Checks That Remain Manual Or Blocked

- Real signup confirmation and password-recovery email: explicitly deferred; requires approved SMTP/provider and an accessible test mailbox.
- Positive payment-proof submission/review: requires a genuine approved test payment destination; do not enable a fake or contact phone destination merely to satisfy a test.
- Real outbound email: requires approved provider, verified sender, and production/test origin.
- Development admin and hosted final import are complete in the linked test project. Repeat provisioning/import only through their guarded commands; both are idempotent and neither should be placed in CI.

Record blocked checks as `NOT RUN` with the exact reason. A passing test-project run does not authorize production deployment, policy publication, sales, payment details, or email sending.
