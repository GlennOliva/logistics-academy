# Logistics VA Training Academy

React 19, strict TypeScript, Vite and Supabase application for Logistics 101. The repository contains the Day 1 vertical slice (public pages, authentication, authoritative order creation, private validated payment-proof submission, student payment status, admin proof inspection) and the Day 2 database layer (enrollment curriculum snapshots, progress, immutable bilingual module materials, quizzes with private answer keys, and trusted server-side scoring).

All six client references in `references/` have been reviewed. Commercial inputs are still missing and this is not a launch-ready paid course. See `docs/progress.md` and `docs/decisions.md`.

## Local Setup

Requirements: Node.js 20+, npm, Supabase CLI for hosted test-project work, and PostgreSQL 17 client binaries for the local verification harness. Docker is optional; the harness runs without it.

```bash
npm install
cp .env.example .env.local
npm run dev
```

Set only browser-safe values in `.env.local`. Keep `VITE_EMAIL_DELIVERY_ENABLED=false` until confirmation and recovery delivery have positive provider/mailbox evidence. Never add a service-role key or provider credential to a `VITE_` variable.

## Commands

```bash
npm run dev
npm run typecheck
npm run lint
npm test
npm run test:db
npm run test:e2e
npm run build
```

`npm run test:db` applies every ordered migration to a throwaway PostgreSQL cluster and runs
the authorization, transaction, progress, and scoring assertions. It proves SQL and
RLS behavior only. Auth email delivery, the Storage API, and Edge Functions require a
hosted Supabase test project; see `docs/supabase-test-setup.md`.

## Supabase Test Setup

1. Create or select an isolated non-production Supabase project.
2. Apply only pending migrations through the CLI migration workflow; never reset a populated environment.
3. Deploy the function directories with the JWT settings in `supabase/config.toml`.
4. Set application-specific function secrets such as `APP_ORIGINS`, `CERTIFICATE_RATE_LIMIT_SALT`, and email-provider values. Supabase supplies its runtime URL and keys.
5. Configure Auth site URL and redirect allowlist for `/auth/callback` and `/reset-password` on local and test origins.
6. Replace development policy versions before any public release.
7. Configure genuine **test** payment destinations, then enable `courses.sales_enabled` and only the verified test methods. Never use the contact phone as a destination.

The database creates all buckets and policies in the migration. Payment proof objects are written only by the validated Edge Function and read only by admins via short-lived links.

## Initial Admin

Use the guarded one-shot scripts from a trusted interactive terminal. Preparation writes a mode-`0600`, gitignored, one-use input from hidden prompts. Provisioning deletes that file as soon as it is read, confirms that the URL matches the linked project, checks for an existing identity, never replaces an existing password, confirms only a newly created bootstrap identity, grants the database role, records an audit event, and verifies password login plus backend admin authorization. Never put the service-role key in `.env.local` or any `VITE_*` variable.

```bash
export INITIAL_ADMIN_EMAIL='owner-approved@example.com'
export ADMIN_PROVISIONING_REASON='Approved bootstrap ticket/reference'
set -a; source .env.local; set +a
npm run provision:admin:prepare
ALLOW_ADMIN_PROVISIONING=1 npm run provision:admin
```

The preparation command prompts invisibly for the service-role key and initial password. If the identity already exists, provisioning does not use the prepared password to update it; it uses it only to verify login. The recipient must change an initial development password through the recovery flow before production use. Production provisioning requires owner authorization; these commands are not migrations and must never run automatically in CI/CD.

## Architecture

- React Router handles public, auth, student and admin route composition.
- Supabase Auth owns passwords, verification and recovery.
- Postgres functions snapshot server-owned prices and link validated payment submissions.
- RLS protects all exposed application tables; database privilege checks do not trust route guards or user metadata.
- The Edge Function authenticates the caller, checks MIME, size and magic bytes, uploads to a private bucket, and links metadata through a service-role-only function.
- Payment methods and course sales are disabled by default until genuine destinations and content gates are satisfied.
- Enrollment curriculum is snapshotted at approval time. Publishing a new module does not change existing student access; an admin must explicitly opt in via `admin_add_module_to_enrollments`, and that action is audited.
- Quiz versions are immutable once published. Answer keys live in a private schema, scores are computed server-side, and attempt limits, cooldowns, and the 75% final threshold are enforced by the database rather than the browser.

## Deployment

`npm run build` produces the static SPA in `dist/`. Configure the selected host to serve `index.html` for unknown application routes, use HTTPS, inject only browser-safe environment values at build time, and apply security headers. Production migration and publication are not authorized by this repository state.
